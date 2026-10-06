import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupDatabase, verifyDatabase } from './sqlite-archive.mjs';

// ===========================================================================
// Off-site encrypted database backups.
//
// `sqlite-archive.mjs` produces a consistent, integrity-checked plaintext
// snapshot (VACUUM INTO). That is the right primitive locally, but a backup that
// leaves the host must be encrypted at rest — otherwise a leaked bucket exposes
// every tenant's data. This module wraps the snapshot in an authenticated
// AES-256-GCM envelope and adds the operational pieces production needs:
// retention pruning and a real restore drill that proves a backup can be
// decrypted, opened, and passes SQLite integrity + schema checks.
//
// Envelope layout (fixed 85-byte header, then ciphertext):
//   [0..8)    magic "SEMO0OBK"
//   [8]       version (1)
//   [9..25)   16-byte scrypt salt
//   [25..37)  12-byte GCM IV
//   [37..53)  16-byte GCM auth tag
//   [53..85)  32-byte SHA-256 of the plaintext (integrity of the decrypted bytes)
//
// The auth tag authenticates the ciphertext; the embedded plaintext hash lets a
// restore detect truncation/corruption even before SQLite opens the file.
// ===========================================================================

const MAGIC = Buffer.from('SEMO0OBK', 'ascii');
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HASH_LEN = 32;
const HEADER_SIZE = MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN + HASH_LEN;
const TAG_OFFSET = MAGIC.length + 1 + SALT_LEN + IV_LEN;
const HASH_OFFSET = TAG_OFFSET + TAG_LEN;
const CHUNK = 64 * 1024;
const BACKUP_EXTENSION = '.bk';

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function resolveKeyMaterial(explicit) {
  const raw = explicit ?? process.env.BACKUP_ENCRYPTION_KEY ?? process.env.SECRETS_MASTER_KEY;
  if (!raw || String(raw).length < 16) throw fail('BACKUP_KEY_REQUIRED');
  return String(raw);
}

// Any key material (hex, base64, or passphrase) is stretched to 32 bytes with a
// per-backup random salt, so a human-chosen key is never used directly as the
// AES key.
function deriveKey(material, salt) {
  return scryptSync(material, salt, 32);
}

async function privateDestination(filePath) {
  const resolved = path.resolve(filePath);
  const basename = path.basename(resolved);
  if (!basename || basename === '.' || basename === '..') throw fail('BACKUP_DESTINATION_INVALID');
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(resolved));
  const parentStat = await stat(parent);
  if ((parentStat.mode & 0o077) !== 0) throw fail('BACKUP_DESTINATION_DIRECTORY_NOT_PRIVATE');
  return path.join(parent, basename);
}

async function requireAbsent(filePath) {
  try {
    await lstat(filePath);
    throw fail('BACKUP_DESTINATION_EXISTS');
  } catch (error) {
    if (error?.code === 'BACKUP_DESTINATION_EXISTS') throw error;
    if (error?.code !== 'ENOENT') throw fail('BACKUP_DESTINATION_UNAVAILABLE', error);
  }
}

async function publishNewFile(tempPath, destination) {
  await link(tempPath, destination);
  await unlink(tempPath);
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function encryptFile(sourcePath, destinationPath, keyMaterial) {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(keyMaterial, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintextHash = createHash('sha256');
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, MAGIC.length);
  salt.copy(header, MAGIC.length + 1);
  iv.copy(header, MAGIC.length + 1 + SALT_LEN);
  const handle = await open(destinationPath, 'wx', 0o600);
  try {
    await handle.write(header, 0, HEADER_SIZE, 0);
    let position = HEADER_SIZE;
    for await (const chunk of createReadStream(sourcePath)) {
      plaintextHash.update(chunk);
      const encrypted = cipher.update(chunk);
      if (encrypted.length) { await handle.write(encrypted, 0, encrypted.length, position); position += encrypted.length; }
    }
    const final = cipher.final();
    if (final.length) { await handle.write(final, 0, final.length, position); position += final.length; }
    await handle.write(cipher.getAuthTag(), 0, TAG_LEN, TAG_OFFSET);
    await handle.write(plaintextHash.digest(), 0, HASH_LEN, HASH_OFFSET);
    await handle.sync();
    return { ciphertextBytes: position - HEADER_SIZE, totalBytes: position };
  } finally {
    await handle.close();
  }
}

async function readHeader(handle) {
  const header = Buffer.alloc(HEADER_SIZE);
  const { bytesRead } = await handle.read(header, 0, HEADER_SIZE, 0);
  if (bytesRead < HEADER_SIZE) throw fail('BACKUP_TRUNCATED');
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw fail('BACKUP_MAGIC_INVALID');
  const version = header.readUInt8(MAGIC.length);
  if (version !== VERSION) throw fail('BACKUP_VERSION_UNSUPPORTED');
  return {
    version,
    salt: header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_LEN),
    iv: header.subarray(MAGIC.length + 1 + SALT_LEN, MAGIC.length + 1 + SALT_LEN + IV_LEN),
    tag: header.subarray(TAG_OFFSET, TAG_OFFSET + TAG_LEN),
    plaintextSha256: header.subarray(HASH_OFFSET, HASH_OFFSET + HASH_LEN).toString('hex'),
  };
}

async function decryptFile(sourcePath, destinationPath, keyMaterial) {
  const handle = await open(sourcePath, 'r');
  const out = await open(destinationPath, 'wx', 0o600);
  try {
    const header = await readHeader(handle);
    const key = deriveKey(keyMaterial, header.salt);
    const decipher = createDecipheriv('aes-256-gcm', key, header.iv);
    decipher.setAuthTag(header.tag);
    const size = (await handle.stat()).size;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(CHUNK);
    let readPos = HEADER_SIZE;
    let writePos = 0;
    while (readPos < size) {
      const toRead = Math.min(buffer.length, size - readPos);
      const { bytesRead } = await handle.read(buffer, 0, toRead, readPos);
      if (!bytesRead) break;
      readPos += bytesRead;
      const decrypted = decipher.update(buffer.subarray(0, bytesRead));
      hash.update(decrypted);
      if (decrypted.length) { await out.write(decrypted, 0, decrypted.length, writePos); writePos += decrypted.length; }
    }
    const final = decipher.final(); // throws if the ciphertext or tag was tampered with
    hash.update(final);
    if (final.length) { await out.write(final, 0, final.length, writePos); writePos += final.length; }
    await out.sync();
    const actual = hash.digest('hex');
    if (actual !== header.plaintextSha256) throw fail('BACKUP_PLAINTEXT_HASH_MISMATCH');
    return { plaintextBytes: writePos, plaintextSha256: actual };
  } catch (error) {
    if (error?.code?.startsWith('BACKUP_')) throw error;
    throw fail('BACKUP_DECRYPT_FAILED', error);
  } finally {
    await handle.close();
    await out.close();
  }
}

/**
 * Create an encrypted backup of `sourceDatabasePath` at `destinationPath`.
 * Returns metadata including the ciphertext SHA-256 and the plaintext SHA-256.
 */
export async function createEncryptedBackup(sourceDatabasePath, destinationPath, { key } = {}) {
  const keyMaterial = resolveKeyMaterial(key);
  const destination = await privateDestination(destinationPath);
  await requireAbsent(destination);
  const tempSnapshot = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.snapshot`;
  const tempEncrypted = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.partial`;
  try {
    const snapshot = await backupDatabase(sourceDatabasePath, tempSnapshot);
    await encryptFile(tempSnapshot, tempEncrypted, keyMaterial);
    await chmod(tempEncrypted, 0o600);
    await publishNewFile(tempEncrypted, destination);
    const info = await stat(destination);
    return {
      operation: 'encrypted-backup',
      path: destination,
      bytes: info.size,
      sha256: await sha256File(destination),
      plaintextSha256: snapshot.sha256,
      schemaVersion: snapshot.schemaVersion,
      encryption: 'aes-256-gcm',
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    throw error?.code?.startsWith('BACKUP_') || error?.code?.startsWith('DATABASE_') ? error : fail('BACKUP_ENCRYPT_FAILED', error);
  } finally {
    await unlink(tempSnapshot).catch(() => {});
    await unlink(tempEncrypted).catch(() => {});
  }
}

/** Decrypt a backup to a new plaintext database file (never overwrites). */
export async function decryptBackup(backupPath, destinationPath, { key } = {}) {
  const keyMaterial = resolveKeyMaterial(key);
  const source = await realpath(path.resolve(backupPath));
  const destination = await privateDestination(destinationPath);
  if (source === destination) throw fail('BACKUP_SOURCE_EQUALS_DESTINATION');
  await requireAbsent(destination);
  const temp = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.restore`;
  try {
    const result = await decryptFile(source, temp, keyMaterial);
    await chmod(temp, 0o600);
    const validation = await verifyDatabase(temp);
    await publishNewFile(temp, destination);
    return {
      operation: 'decrypt',
      path: destination,
      bytes: result.plaintextBytes,
      plaintextSha256: result.plaintextSha256,
      schemaVersion: validation.schemaVersion,
    };
  } catch (error) {
    throw error?.code?.startsWith('BACKUP_') || error?.code?.startsWith('DATABASE_') ? error : fail('BACKUP_DECRYPT_FAILED', error);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Decrypt-and-verify without leaving a restored database behind. */
export async function verifyEncryptedBackup(backupPath, { key } = {}) {
  const keyMaterial = resolveKeyMaterial(key);
  const source = await realpath(path.resolve(backupPath));
  const dir = path.dirname(source);
  const temp = path.join(dir, `.verify-${process.pid}-${randomBytes(6).toString('hex')}.sqlite`);
  try {
    const result = await decryptFile(source, temp, keyMaterial);
    const validation = await verifyDatabase(temp);
    const info = await stat(source);
    return {
      operation: 'verify',
      ok: true,
      path: source,
      bytes: info.size,
      plaintextBytes: result.plaintextBytes,
      plaintextSha256: result.plaintextSha256,
      schemaVersion: validation.schemaVersion,
    };
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/**
 * A full restore drill: decrypt the backup, confirm it opens, and run the same
 * integrity/foreign-key/schema checks a real restore would. This is what an
 * operator schedules to prove backups are actually restorable.
 */
export async function restoreDrill(backupPath, { key } = {}) {
  const startedAt = Date.now();
  const verified = await verifyEncryptedBackup(backupPath, { key });
  // Spread first, then override: `verifyEncryptedBackup` reports
  // `operation: 'verify'`, but a drill must be distinguishable in logs/metrics.
  return { ...verified, operation: 'restore-drill', ok: verified.ok, durationMs: Date.now() - startedAt };
}

/**
 * Retention: keep the newest `keep` backup files in `directory` (by mtime) and
 * delete the rest. Only files ending in `.bk` are considered, so a stray file is
 * never removed.
 */
export async function pruneBackups(directory, { keep = 7 } = {}) {
  const resolved = path.resolve(directory);
  const entries = await readdir(resolved, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(BACKUP_EXTENSION)) continue;
    const full = path.join(resolved, entry.name);
    const info = await stat(full);
    files.push({ path: full, mtimeMs: info.mtimeMs, bytes: info.size });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const keepCount = Math.max(0, Math.floor(Number(keep)) || 0);
  const retained = files.slice(0, keepCount);
  const removed = files.slice(keepCount);
  for (const file of removed) await unlink(file.path);
  return { operation: 'prune', kept: retained.length, deleted: removed.length, removed: removed.map((file) => file.path) };
}

function usage() {
  return [
    'Usage:',
    '  node backend/ops/backup.mjs backup <source-db> <new-backup.bk>',
    '  node backend/ops/backup.mjs verify <backup.bk>',
    '  node backend/ops/backup.mjs restore <backup.bk> <new-database-file>',
    '  node backend/ops/backup.mjs drill <backup.bk>',
    '  node backend/ops/backup.mjs prune <backup-directory> [keep]',
    'Set BACKUP_ENCRYPTION_KEY (or SECRETS_MASTER_KEY) to the encryption key.',
  ].join('\n');
}

async function main(argv) {
  const [command, first, second] = argv;
  if (command === 'backup' && first && second) return createEncryptedBackup(first, second);
  if (command === 'verify' && first) return verifyEncryptedBackup(first);
  if (command === 'restore' && first && second) return decryptBackup(first, second);
  if (command === 'drill' && first) return restoreDrill(first);
  if (command === 'prune' && first) return pruneBackups(first, { keep: second ? Number(second) : 7 });
  throw fail('BACKUP_USAGE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((result) => { console.log(JSON.stringify(result, null, 2)); })
    .catch((error) => {
      if (error?.code === 'BACKUP_USAGE') console.error(usage());
      console.error(`BACKUP_ERROR: ${error?.code ?? 'UNKNOWN'}`);
      process.exitCode = 1;
    });
}
