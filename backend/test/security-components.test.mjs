import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { encryptSecret, decryptSecret, redactSecrets } from '../secrets/vault.mjs';
import { assertSafeUrl, assertWorkspacePath } from '../security/validators.mjs';
import { ModelRouter } from '../models/router.mjs';
import { MemoryStore } from '../memory/store.mjs';
import { createTelemetry } from '../observability/telemetry.mjs';

test('secrets are encrypted and redacted', () => {
  process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  const encoded = encryptSecret('top-secret');
  assert.notEqual(encoded, 'top-secret');
  assert.equal(decryptSecret(encoded), 'top-secret');
  assert.equal(redactSecrets('token=top-secret', ['top-secret']), 'token=[REDACTED]');
});
test('security validators block traversal and SSRF targets', () => {
  assert.equal(assertWorkspacePath('src/app.ts'), 'src/app.ts');
  assert.throws(() => assertWorkspacePath('../secret'), /PATH_OUTSIDE_WORKSPACE/);
  assert.throws(() => assertSafeUrl('http://127.0.0.1:8080'), /SSRF_TARGET_NOT_ALLOWED/);
  assert.throws(() => assertSafeUrl('file:///etc/passwd'), /URL_SCHEME_NOT_ALLOWED/);
});
test('model router chooses healthy capable provider and fails closed', () => {
  const router = new ModelRouter([{ id: 'cheap', taskTypes: ['general'], contextTokens: 1000, costPer1k: 0.1, latencyMs: 100 }, { id: 'vision', vision: true, contextTokens: 5000, costPer1k: 1, latencyMs: 200 }]);
  assert.equal(router.choose({ taskType: 'general' }).id, 'cheap');
  assert.equal(router.choose({ needsVision: true }).id, 'vision');
  router.updateHealth('vision', false);
  assert.throws(() => router.choose({ needsVision: true }), /NO_HEALTHY_MODEL/);
});
test('memory store isolates project retrieval', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-memory-')); const db = new Database(path.join(dir, 'db.sqlite'));
  try {
    const memory = new MemoryStore(db); const timestamp = new Date().toISOString();
    db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', 't1', 'Tenant', timestamp);
    db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', 'u1', 't1', 'owner@example.test', 'test', 'owner', timestamp);
    db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', 'p1', 't1', 'u1', 'One', timestamp);
    db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', 'p2', 't1', 'u1', 'Two', timestamp);
    memory.addDocument({ tenantId: 't1', projectId: 'p1', source: 'a', content: 'alpha workspace security' }); memory.addDocument({ tenantId: 't1', projectId: 'p2', source: 'b', content: 'beta workspace' });
    assert.equal(memory.search({ tenantId: 't1', projectId: 'p1', query: 'alpha' })[0].source, 'a');
    assert.equal(memory.search({ tenantId: 't1', projectId: 'p2', query: 'alpha' })[0].source, 'b');
    assert.throws(() => memory.search({ tenantId: 'other', projectId: 'p1', query: 'alpha' }), /MEMORY_PROJECT_NOT_FOUND/);
    assert.equal(memory.exportProject('t1', 'p1').length, 1);
    assert.equal(memory.reindexProject('t1', 'p1').indexed, 1);
    assert.equal(memory.deleteExpired({ tenantId: 't1', projectId: 'p1', before: new Date(0) }).changes, 0);
    assert.equal(memory.deleteProject('t1', 'p1').changes, 1);
    assert.equal(memory.exportProject('t1', 'p1').length, 0);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
test('telemetry emits correlated structured spans and metrics', async () => {
  const records = []; const telemetry = createTelemetry({ sink: (record) => records.push(record) });
  const result = await telemetry.span('test', { runId: 'run_1' }, async () => 42); telemetry.increment('runs'); telemetry.observe('latency', 12);
  assert.equal(result, 42); assert.equal(telemetry.snapshot().runs, 1); assert.ok(records.some((record) => record.event === 'span.completed'));
});
