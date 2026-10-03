import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REQUIRED_TABLES = ['schema_migrations', 'tenants', 'users', 'projects', 'runs'];

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function existingDatabasePath(filePath) {
  const resolved = path.resolve(filePath);
  let info;
  try { info = await lstat(resolved); } catch (error) { throw fail(error.code === 'ENOENT' ? 'DATABASE_FILE_NOT_FOUND' : 'DATABASE_FILE_UNAVAILABLE', error); }
  if (info.isSymbolicLink() || !info.isFile()) throw fail('DATABASE_FILE_MUST_BE_REGULAR_FILE');
  return realpath(resolved);
}

async function newPrivateFilePath(filePath) {
  const resolved = path.resolve(filePath);
  const basename = path.basename(resolved);
  if (!basename || basename === '.' || basename === '..') throw fail('DATABASE_DESTINATION_INVALID');
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(resolved));
  const parentStat = await stat(parent);
  if ((parentStat.mode & 0o077) !== 0) throw fail('DATABASE_DESTINATION_DIRECTORY_NOT_PRIVATE');
  return path.join(parent, basename);
}

async function requireAbsent(filePath) {
  try {
    await lstat(filePath);
    throw fail('DATABASE_DESTINATION_EXISTS');
  } catch (error) {
    if (error?.code === 'DATABASE_DESTINATION_EXISTS') throw error;
    if (error?.code !== 'ENOENT') throw fail('DATABASE_DESTINATION_UNAVAILABLE', error);
  }
}

function validateOpenDatabase(filePath) {
  let db;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') throw fail('DATABASE_INTEGRITY_CHECK_FAILED');
    const foreignKeyErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) throw fail('DATABASE_FOREIGN_KEY_CHECK_FAILED');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
    if (REQUIRED_TABLES.some((name) => !tables.has(name))) throw fail('DATABASE_SCHEMA_NOT_RECOGNIZED');
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version ?? 0;
    return { schemaVersion: Number(version) };
  } catch (error) {
    if (error?.code?.startsWith('DATABASE_')) throw error;
    throw fail('DATABASE_ARCHIVE_INVALID', error);
  } finally {
    db?.close();
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function syncFile(filePath) {
  const handle = await open(filePath, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function publishNewFile(tempPath, destination) {
  // link() is an atomic no-overwrite publish on the same filesystem.
  await link(tempPath, destination);
  await unlink(tempPath);
  await syncDirectory(path.dirname(destination));
}

async function finishArchive(operation, filePath, extra = {}) {
  const info = await stat(filePath);
  return {
    operation,
    path: filePath,
    bytes: info.size,
    sha256: await sha256File(filePath),
    ...extra,
  };
}

export async function verifyDatabase(filePath) {
  const source = await existingDatabasePath(filePath);
  const validation = validateOpenDatabase(source);
  return finishArchive('verify', source, validation);
}

export async function backupDatabase(sourcePath, destinationPath) {
  const source = await existingDatabasePath(sourcePath);
  const destination = await newPrivateFilePath(destinationPath);
  if (source === destination) throw fail('DATABASE_SOURCE_EQUALS_DESTINATION');
  await requireAbsent(destination);
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.partial`);
  let tempHandle;
  let sourceDb;
  try {
    tempHandle = await open(tempPath, 'wx', 0o600);
    await tempHandle.close();
    tempHandle = null;
    sourceDb = new DatabaseSync(source, { readOnly: true });
    sourceDb.prepare('VACUUM INTO ?').run(tempPath);
    sourceDb.close();
    sourceDb = null;
    await chmod(tempPath, 0o600);
    const validation = validateOpenDatabase(tempPath);
    await syncFile(tempPath);
    await publishNewFile(tempPath, destination);
    return finishArchive('backup', destination, validation);
  } catch (error) {
    throw error?.code?.startsWith('DATABASE_') ? error : fail('DATABASE_BACKUP_FAILED', error);
  } finally {
    sourceDb?.close();
    await tempHandle?.close().catch(() => {});
    await unlink(tempPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
}

export async function restoreDatabase(backupPath, newDatabasePath) {
  const source = await existingDatabasePath(backupPath);
  const sourceValidation = validateOpenDatabase(source);
  const destination = await newPrivateFilePath(newDatabasePath);
  if (source === destination) throw fail('DATABASE_SOURCE_EQUALS_DESTINATION');
  await requireAbsent(destination);
  const tempPath = path.join(path.dirname(destination), `.${path.basename(destination)}.${process.pid}.${randomUUID()}.restore`);
  try {
    await copyFile(source, tempPath, fsConstants.COPYFILE_EXCL);
    await chmod(tempPath, 0o600);
    const restoredValidation = validateOpenDatabase(tempPath);
    await syncFile(tempPath);
    await publishNewFile(tempPath, destination);
    return finishArchive('restore-to-new-file', destination, {
      schemaVersion: restoredValidation.schemaVersion,
      sourceSha256: await sha256File(source),
      sourceSchemaVersion: sourceValidation.schemaVersion,
    });
  } catch (error) {
    throw error?.code?.startsWith('DATABASE_') ? error : fail('DATABASE_RESTORE_FAILED', error);
  } finally {
    await unlink(tempPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
}

function usage() {
  return [
    'Usage:',
    '  node backend/ops/sqlite-archive.mjs backup <source-db> <new-backup-file>',
    '  node backend/ops/sqlite-archive.mjs verify <database-file>',
    '  node backend/ops/sqlite-archive.mjs restore <backup-file> <new-database-file>',
    'Restore creates a new file and never overwrites an existing database.',
  ].join('\n');
}

async function main(argv) {
  const [command, first, second, ...rest] = argv;
  if (rest.length) throw fail('DATABASE_ARCHIVE_INVALID_ARGUMENTS');
  if (command === 'backup' && first && second) return backupDatabase(first, second);
  if (command === 'verify' && first && !second) return verifyDatabase(first);
  if (command === 'restore' && first && second) return restoreDatabase(first, second);
  throw fail('DATABASE_ARCHIVE_USAGE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((result) => { console.log(JSON.stringify(result, null, 2)); })
    .catch((error) => {
      if (error?.code === 'DATABASE_ARCHIVE_USAGE' || error?.code === 'DATABASE_ARCHIVE_INVALID_ARGUMENTS') console.error(usage());
      console.error(`DATABASE_ARCHIVE_ERROR: ${error?.code ?? 'UNKNOWN'}`);
      process.exitCode = 1;
    });
}
