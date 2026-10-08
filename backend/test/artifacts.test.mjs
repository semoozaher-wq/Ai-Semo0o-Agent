import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { ArtifactStore, createArtifactStore, guessMimeType, sha256Hex } from '../artifacts/store.mjs';

/**
 * Artifact ledger. Proves the previously-dead `artifacts` table is now a real,
 * queryable, hash-verified record of the files a run produced, against a real
 * SQLite database.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-artifacts-'));

function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  const runId = id('run');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Art Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'art@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Art Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'goal', 'running', t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'running', '{}', 0, t, t);
  return { tenantId, userId, projectId, taskId, runId };
}

test('guessMimeType maps known extensions and defaults safely', () => {
  assert.equal(guessMimeType('a/b/report.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(guessMimeType('clip.mp4'), 'video/mp4');
  assert.equal(guessMimeType('voice.wav'), 'audio/wav');
  assert.equal(guessMimeType('mystery.bin'), 'application/octet-stream');
  assert.equal(guessMimeType(''), 'application/octet-stream');
});

test('recordBuffer stores a hashed, typed artifact row', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'a.sqlite'));
    const { runId } = seed(db);
    const store = new ArtifactStore(db);
    const payload = Buffer.from('hello artifact world');
    const row = store.recordBuffer({ runId, path: 'out/hello.txt', buffer: payload, kind: 'document', meta: { tool: 'test' } });
    assert.equal(row.run_id, runId);
    assert.equal(row.path, 'out/hello.txt');
    assert.equal(row.sha256, sha256Hex(payload));
    assert.equal(row.size_bytes, payload.length);
    assert.equal(row.kind, 'document');
    assert.equal(row.mime_type, 'text/plain');
    assert.deepEqual(JSON.parse(row.meta_json), { tool: 'test' });
    assert.equal(store.count(runId), 1);
    assert.equal(store.list(runId).length, 1);
    assert.equal(store.get(row.id).id, row.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordFile hashes the real bytes on disk and verify() detects tampering', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'a.sqlite'));
    const { runId } = seed(db);
    const store = createArtifactStore(db);
    const file = path.join(dir, 'doc.pdf');
    await writeFile(file, Buffer.from('%PDF-1.7 real content'));
    const row = await store.recordFile({ runId, absolutePath: file, path: 'reports/doc.pdf' });
    assert.equal(row.mime_type, 'application/pdf');
    const good = await store.verify(row.id, file);
    assert.equal(good.ok, true);
    // Tamper with the file: verify must report the mismatch honestly.
    await writeFile(file, Buffer.from('%PDF-1.7 TAMPERED'));
    const bad = await store.verify(row.id, file);
    assert.equal(bad.ok, false);
    assert.notEqual(bad.actual, bad.expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordBuffer rejects missing run id and oversized payloads', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'a.sqlite'));
    const { runId } = seed(db);
    const store = new ArtifactStore(db);
    assert.throws(() => store.recordBuffer({ path: 'x.txt', buffer: 'x' }), /ARTIFACT_RUN_REQUIRED/);
    assert.throws(() => store.recordBuffer({ runId, path: 'x.txt', buffer: Buffer.alloc(64 * 1024 * 1024 + 1) }), /ARTIFACT_TOO_LARGE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('delete removes the row and reports honestly', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'a.sqlite'));
    const { runId } = seed(db);
    const store = new ArtifactStore(db);
    const row = store.recordBuffer({ runId, path: 'x.txt', buffer: 'x' });
    assert.equal(store.delete(row.id).deleted, true);
    assert.equal(store.get(row.id), null);
    assert.equal(store.delete(row.id).deleted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
