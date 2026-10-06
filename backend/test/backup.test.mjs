import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, id, now } from '../db/client.mjs';
import { verifyDatabase } from '../ops/sqlite-archive.mjs';
import { createEncryptedBackup, decryptBackup, pruneBackups, restoreDrill, verifyEncryptedBackup } from '../ops/backup.mjs';

const KEY = 'test-backup-key-material-0123456789';
const OTHER_KEY = 'a-completely-different-key-material-9876';

// Build a real, migrated database file with one identifiable tenant so a restore
// can prove the data actually round-tripped.
async function makeSourceDatabase(dir) {
  const sourcePath = path.join(dir, 'source.sqlite');
  const db = new Database(sourcePath);
  const tenantId = id('tenant');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Round Trip Co', now());
  db.close();
  return { sourcePath, tenantId };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-backup-'));
  const backups = path.join(dir, 'backups');
  await mkdir(backups, { mode: 0o700 });
  return { dir, backups, close: async () => { await rm(dir, { recursive: true, force: true }); } };
}

test('an encrypted backup round-trips: create -> verify -> drill -> restore', async () => {
  const fx = await fixture();
  try {
    const { sourcePath, tenantId } = await makeSourceDatabase(fx.dir);
    const backupPath = path.join(fx.backups, 'snapshot.bk');

    const created = await createEncryptedBackup(sourcePath, backupPath, { key: KEY });
    assert.equal(created.operation, 'encrypted-backup');
    assert.equal(created.encryption, 'aes-256-gcm');
    assert.ok(created.bytes > 0);
    assert.match(created.sha256, /^[0-9a-f]{64}$/);
    assert.match(created.plaintextSha256, /^[0-9a-f]{64}$/);
    assert.ok(created.schemaVersion >= 1);
    const info = await stat(backupPath);
    assert.equal(info.size, created.bytes);

    const verified = await verifyEncryptedBackup(backupPath, { key: KEY });
    assert.equal(verified.ok, true);
    assert.equal(verified.plaintextSha256, created.plaintextSha256);

    const drill = await restoreDrill(backupPath, { key: KEY });
    assert.equal(drill.ok, true);
    assert.equal(drill.operation, 'restore-drill');
    assert.ok(drill.durationMs >= 0);

    // Restore to a new file and confirm the tenant survived the round trip.
    const restoredPath = path.join(fx.dir, 'restored.sqlite');
    const restored = await decryptBackup(backupPath, restoredPath, { key: KEY });
    assert.equal(restored.operation, 'decrypt');
    const validation = await verifyDatabase(restoredPath);
    assert.ok(validation.schemaVersion >= 1);
    const restoredDb = new Database(restoredPath);
    try {
      const row = restoredDb.get('SELECT name FROM tenants WHERE id=?', tenantId);
      assert.equal(row?.name, 'Round Trip Co');
    } finally { restoredDb.close(); }
  } finally { await fx.close(); }
});

test('a tampered ciphertext is rejected (GCM auth failure)', async () => {
  const fx = await fixture();
  try {
    const { sourcePath } = await makeSourceDatabase(fx.dir);
    const backupPath = path.join(fx.backups, 'snapshot.bk');
    await createEncryptedBackup(sourcePath, backupPath, { key: KEY });

    // Flip a byte well past the 85-byte header (inside the ciphertext).
    const bytes = await readFile(backupPath);
    const target = bytes.length - 10;
    bytes[target] ^= 0xff;
    const tampered = path.join(fx.backups, 'tampered.bk');
    await writeFile(tampered, bytes, { mode: 0o600 });

    await assert.rejects(() => verifyEncryptedBackup(tampered, { key: KEY }), (error) => {
      assert.ok(String(error.code).startsWith('BACKUP_'), `unexpected code ${error.code}`);
      return true;
    });
  } finally { await fx.close(); }
});

test('a truncated backup is rejected before SQLite ever opens it', async () => {
  const fx = await fixture();
  try {
    const { sourcePath } = await makeSourceDatabase(fx.dir);
    const backupPath = path.join(fx.backups, 'snapshot.bk');
    await createEncryptedBackup(sourcePath, backupPath, { key: KEY });

    const bytes = await readFile(backupPath);
    const truncated = path.join(fx.backups, 'truncated.bk');
    await writeFile(truncated, bytes.subarray(0, 40), { mode: 0o600 }); // < 85-byte header

    await assert.rejects(() => verifyEncryptedBackup(truncated, { key: KEY }), (error) => {
      assert.equal(error.code, 'BACKUP_TRUNCATED');
      return true;
    });
  } finally { await fx.close(); }
});

test('the wrong key cannot decrypt a backup', async () => {
  const fx = await fixture();
  try {
    const { sourcePath } = await makeSourceDatabase(fx.dir);
    const backupPath = path.join(fx.backups, 'snapshot.bk');
    await createEncryptedBackup(sourcePath, backupPath, { key: KEY });
    await assert.rejects(() => verifyEncryptedBackup(backupPath, { key: OTHER_KEY }), (error) => {
      assert.ok(String(error.code).startsWith('BACKUP_'), `unexpected code ${error.code}`);
      return true;
    });
  } finally { await fx.close(); }
});

test('a backup requires key material and refuses to overwrite', async () => {
  const fx = await fixture();
  try {
    const { sourcePath } = await makeSourceDatabase(fx.dir);
    const backupPath = path.join(fx.backups, 'snapshot.bk');

    // No key anywhere -> hard failure.
    const savedKey = process.env.BACKUP_ENCRYPTION_KEY;
    const savedMaster = process.env.SECRETS_MASTER_KEY;
    delete process.env.BACKUP_ENCRYPTION_KEY;
    delete process.env.SECRETS_MASTER_KEY;
    try {
      await assert.rejects(() => createEncryptedBackup(sourcePath, backupPath), (error) => {
        assert.equal(error.code, 'BACKUP_KEY_REQUIRED');
        return true;
      });
    } finally {
      if (savedKey !== undefined) process.env.BACKUP_ENCRYPTION_KEY = savedKey;
      if (savedMaster !== undefined) process.env.SECRETS_MASTER_KEY = savedMaster;
    }

    // First write succeeds; a second write to the same path must not clobber it.
    await createEncryptedBackup(sourcePath, backupPath, { key: KEY });
    await assert.rejects(() => createEncryptedBackup(sourcePath, backupPath, { key: KEY }), (error) => {
      assert.equal(error.code, 'BACKUP_DESTINATION_EXISTS');
      return true;
    });
  } finally { await fx.close(); }
});

test('a backup refuses a world-readable destination directory', async () => {
  const fx = await fixture();
  try {
    const { sourcePath } = await makeSourceDatabase(fx.dir);
    const loose = path.join(fx.dir, 'loose');
    await mkdir(loose, { mode: 0o755 });
    await assert.rejects(() => createEncryptedBackup(sourcePath, path.join(loose, 'x.bk'), { key: KEY }), (error) => {
      assert.equal(error.code, 'BACKUP_DESTINATION_DIRECTORY_NOT_PRIVATE');
      return true;
    });
  } finally { await fx.close(); }
});

test('pruneBackups keeps the newest N .bk files and ignores everything else', async () => {
  const fx = await fixture();
  try {
    const names = ['a.bk', 'b.bk', 'c.bk', 'd.bk'];
    for (const [index, name] of names.entries()) {
      const full = path.join(fx.backups, name);
      await writeFile(full, `backup-${index}`, { mode: 0o600 });
      // Distinct, deterministic mtimes so "newest" is unambiguous.
      const when = new Date(1_700_000_000_000 + index * 60_000);
      await utimes(full, when, when);
    }
    // A stray non-.bk file must never be pruned.
    const keepMe = path.join(fx.backups, 'notes.txt');
    await writeFile(keepMe, 'do not delete', { mode: 0o600 });

    const result = await pruneBackups(fx.backups, { keep: 2 });
    assert.equal(result.kept, 2);
    assert.equal(result.deleted, 2);
    const files = await readdir(fx.backups);
    assert.deepEqual(files.sort(), ['c.bk', 'd.bk', 'notes.txt']);
  } finally { await fx.close(); }
});

test('the CLI entrypoint backs up and verifies a database end-to-end', async () => {
  const fx = await fixture();
  try {
    const { sourcePath } = await makeSourceDatabase(fx.dir);
    const backupPath = path.join(fx.backups, 'cli.bk');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const env = { ...process.env, BACKUP_ENCRYPTION_KEY: KEY };

    const created = await run(process.execPath, ['--experimental-sqlite', 'backend/ops/backup.mjs', 'backup', sourcePath, backupPath], { env, cwd: path.resolve('.') });
    const createdJson = JSON.parse(created.stdout);
    assert.equal(createdJson.operation, 'encrypted-backup');

    const verified = await run(process.execPath, ['--experimental-sqlite', 'backend/ops/backup.mjs', 'verify', backupPath], { env, cwd: path.resolve('.') });
    const verifiedJson = JSON.parse(verified.stdout);
    assert.equal(verifiedJson.ok, true);
  } finally { await fx.close(); }
});
