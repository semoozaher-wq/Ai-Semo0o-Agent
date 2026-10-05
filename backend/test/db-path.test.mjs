import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, databaseFileCandidates, resolveDatabaseFile } from '../db/client.mjs';

// A path whose nearest existing ancestor is a *file* (not a directory) can never
// be made writable. This reproduces the Render Free situation (`/var/data` is not
// writable) in a way that is independent of the user running the tests, so the
// "skip an unwritable path" logic is exercised deterministically.
async function unwritablePath(directory) {
  const blocker = path.join(directory, 'blocker');
  await writeFile(blocker, 'not a directory');
  return path.join(blocker, 'db', 'agent.sqlite');
}

test('databaseFileCandidates keeps DATABASE_FILE first and appends safe fallbacks', () => {
  const candidates = databaseFileCandidates({ DATABASE_FILE: '/var/data/db/agent.sqlite', DATABASE_DIR: '/var/data/db2' });
  assert.equal(candidates[0], path.resolve('/var/data/db/agent.sqlite'));
  assert.equal(candidates[1], path.resolve('/var/data/db2/agent.sqlite'));
  assert.ok(candidates.includes(path.resolve('backend', 'data', 'agent.sqlite')));
  assert.ok(candidates.includes(path.join(os.tmpdir(), 'semo0o', 'agent.sqlite')));
  assert.equal(new Set(candidates).size, candidates.length, 'candidates must be de-duplicated');
});

test('resolveDatabaseFile skips an unwritable DATABASE_FILE and falls back to DATABASE_DIR', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'semo0o-dbpath-'));
  try {
    const bad = await unwritablePath(directory);
    const goodDir = path.join(directory, 'good');
    await mkdir(goodDir, { mode: 0o700 });
    const resolved = resolveDatabaseFile({ DATABASE_FILE: bad, DATABASE_DIR: goodDir }, { logger: { warn() {} } });
    assert.equal(resolved, path.join(goodDir, 'agent.sqlite'));
    assert.equal((await stat(goodDir)).mode & 0o777, 0o700);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Database boots without EACCES when DATABASE_FILE is unwritable (Render Free)', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'semo0o-dbpath-boot-'));
  const saved = { DATABASE_FILE: process.env.DATABASE_FILE, DATABASE_DIR: process.env.DATABASE_DIR };
  try {
    const bad = await unwritablePath(directory);
    const goodDir = path.join(directory, 'good');
    await mkdir(goodDir, { mode: 0o700 });
    process.env.DATABASE_FILE = bad;
    process.env.DATABASE_DIR = goodDir;
    const db = new Database();
    try {
      assert.equal(db.file, path.join(goodDir, 'agent.sqlite'));
      assert.equal((await stat(db.file)).mode & 0o777, 0o600);
      assert.equal(db.get('SELECT COUNT(*) AS count FROM tenants').count, 0);
    } finally { db.close(); }
  } finally {
    if (saved.DATABASE_FILE === undefined) delete process.env.DATABASE_FILE; else process.env.DATABASE_FILE = saved.DATABASE_FILE;
    if (saved.DATABASE_DIR === undefined) delete process.env.DATABASE_DIR; else process.env.DATABASE_DIR = saved.DATABASE_DIR;
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolveDatabaseFile rejects an existing world/group-accessible directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'semo0o-dbpath-shared-'));
  try {
    const shared = path.join(directory, 'shared');
    const goodDir = path.join(directory, 'good');
    await mkdir(shared, { mode: 0o700 });
    await mkdir(goodDir, { mode: 0o700 });
    await chmod(shared, 0o755);
    const resolved = resolveDatabaseFile({ DATABASE_FILE: path.join(shared, 'agent.sqlite'), DATABASE_DIR: goodDir }, { logger: { warn() {} } });
    assert.equal(resolved, path.join(goodDir, 'agent.sqlite'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
