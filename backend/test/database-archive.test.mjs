import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { backupDatabase, restoreDatabase, verifyDatabase } from '../ops/sqlite-archive.mjs';

const timestamp = '2026-10-04T00:00:00.000Z';

test('SQLite database files are private and reject a group/world-accessible data directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-semo0o-db-permissions-'));
  const privateDirectory = path.join(directory, 'private');
  const sharedDirectory = path.join(directory, 'shared');
  await mkdir(privateDirectory, { mode: 0o700 });
  await mkdir(sharedDirectory, { mode: 0o700 });
  await chmod(sharedDirectory, 0o755);
  try {
    const db = new Database(path.join(privateDirectory, 'private.sqlite'));
    db.close();
    assert.equal((await stat(path.join(privateDirectory, 'private.sqlite')).then((info) => info.mode)) & 0o777, 0o600);
    assert.throws(() => new Database(path.join(sharedDirectory, 'rejected.sqlite')), /DATABASE_DIRECTORY_NOT_PRIVATE/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SQLite archive snapshots live committed data and restores to a new verified file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-semo0o-db-archive-'));
  const sourcePath = path.join(directory, 'live.sqlite');
  const backupPath = path.join(directory, 'backups', 'snapshot.sqlite');
  const restoredPath = path.join(directory, 'restored', 'agent.sqlite');
  const db = new Database(sourcePath);
  try {
    db.run('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)', 'tenant_archive_test', 'Archive test', timestamp);
    db.run('INSERT INTO users (id, tenant_id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'user_archive_test', 'tenant_archive_test', 'archive@example.test', 'scrypt:test', 'owner', timestamp);

    const backup = await backupDatabase(sourcePath, backupPath);
    assert.equal(backup.operation, 'backup');
    assert.equal(backup.schemaVersion, 1);
    assert.match(backup.sha256, /^[a-f0-9]{64}$/);
    assert.equal((await stat(backupPath)).mode & 0o777, 0o600);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM users WHERE id=?', 'user_archive_test').count, 1);

    const verified = await verifyDatabase(backupPath);
    assert.equal(verified.operation, 'verify');
    assert.equal(verified.sha256, backup.sha256);

    const restored = await restoreDatabase(backupPath, restoredPath);
    assert.equal(restored.operation, 'restore-to-new-file');
    assert.equal(restored.sourceSha256, backup.sha256);
    assert.equal((await stat(restoredPath)).mode & 0o777, 0o600);
    const restoredDb = new Database(restoredPath);
    try {
      assert.equal(restoredDb.get('SELECT email FROM users WHERE id=?', 'user_archive_test').email, 'archive@example.test');
      assert.deepEqual(restoredDb.all('PRAGMA foreign_key_check'), []);
    } finally { restoredDb.close(); }

    await assert.rejects(backupDatabase(sourcePath, backupPath), (error) => error.code === 'DATABASE_DESTINATION_EXISTS');
    await assert.rejects(restoreDatabase(backupPath, restoredPath), (error) => error.code === 'DATABASE_DESTINATION_EXISTS');
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite archive verifier rejects a regular but non-SQLite file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-semo0o-db-invalid-'));
  const invalidPath = path.join(directory, 'invalid.sqlite');
  try {
    await writeFile(invalidPath, 'not a sqlite database');
    await assert.rejects(verifyDatabase(invalidPath), (error) => error.code === 'DATABASE_ARCHIVE_INVALID');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
