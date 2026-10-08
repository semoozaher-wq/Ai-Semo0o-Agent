import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { validateEnv } from '../config/env.mjs';
import { collectMetrics, renderPrometheus } from '../observability/metrics.mjs';

/**
 * Production reliability: bounded queue retry backoff, stricter startup config
 * validation, and artifact/scheduler observability. All exercised against real
 * SQLite rows and the real modules.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-rel-'));

function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Rel Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'rel@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Rel Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  return { tenantId, userId, projectId, workspaceId };
}

function seedTask(db, seedData, goal = 'g') {
  const taskId = id('task');
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, seedData.tenantId, seedData.projectId, seedData.workspaceId, seedData.userId, goal, 'queued', now(), now());
  return taskId;
}

/* ------------------------------ Queue backoff ----------------------------- */

test('a failed run is parked with next_attempt_at and is not re-run until the backoff elapses', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    // A large base backoff so we can observe the "parked" state deterministically.
    const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 3, retryBackoffMs: 5_000, retryBackoffMaxMs: 60_000 });
    let calls = 0;
    queue.register('code.run', async () => { calls += 1; throw new Error('transient'); });
    const run = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'code.run' }, kind: 'code.run' });

    await queue.tick();
    assert.equal(calls, 1);
    const parked = db.get('SELECT * FROM runs WHERE id=?', run.id);
    assert.equal(parked.status, 'queued', 'a retryable failure re-queues the run');
    assert.equal(parked.attempts, 1);
    assert.ok(parked.next_attempt_at, 'next_attempt_at must be set');
    assert.ok(parked.next_attempt_at > now(), 'next_attempt_at must be in the future');
    assert.equal(JSON.parse(parked.result_json).retrying, true);

    // An immediate tick must NOT re-run it (still within the backoff window).
    await queue.tick();
    assert.equal(calls, 1, 'the run must not hot-loop during the backoff window');

    // Simulate the backoff elapsing by rewinding next_attempt_at.
    db.run('UPDATE runs SET next_attempt_at=? WHERE id=?', new Date(Date.now() - 1_000).toISOString(), run.id);
    await queue.tick();
    assert.equal(calls, 2, 'once the backoff elapses the run is retried');

    // Exhaust attempts: the third failure is terminal.
    db.run('UPDATE runs SET next_attempt_at=? WHERE id=?', new Date(Date.now() - 1_000).toISOString(), run.id);
    await queue.tick();
    assert.equal(calls, 3);
    const failed = db.get('SELECT * FROM runs WHERE id=?', run.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempts, 3);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('retryBackoffMs=0 preserves the immediate-requeue behaviour', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 2, retryBackoffMs: 0 });
    let calls = 0;
    queue.register('code.run', async () => { calls += 1; throw new Error('boom'); });
    const run = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'code.run' }, kind: 'code.run' });
    await queue.tick();
    const parked = db.get('SELECT * FROM runs WHERE id=?', run.id);
    assert.equal(parked.next_attempt_at, null, 'no backoff means no parked window');
    await queue.tick();
    assert.equal(calls, 2);
    assert.equal(db.get('SELECT status FROM runs WHERE id=?', run.id).status, 'failed');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a successful retry clears next_attempt_at', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 3, retryBackoffMs: 0 });
    let calls = 0;
    queue.register('code.run', async () => { calls += 1; if (calls === 1) throw new Error('once'); return { status: 'completed' }; });
    const run = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'code.run' }, kind: 'code.run' });
    await queue.tick();
    await queue.tick();
    assert.equal(calls, 2);
    const row = db.get('SELECT * FROM runs WHERE id=?', run.id);
    assert.equal(row.status, 'completed');
    assert.equal(row.next_attempt_at, null);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- Config validation ---------------------------- */

test('validateEnv rejects malformed numeric tuning knobs', () => {
  const bad = validateEnv({ TRIGGER_CONCURRENCY: 'abc' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes('INVALID_NUMERIC_TRIGGER_CONCURRENCY'));

  const negative = validateEnv({ WORKER_MAX_ATTEMPTS: '-1' });
  assert.ok(negative.errors.includes('INVALID_NUMERIC_WORKER_MAX_ATTEMPTS'));

  const float = validateEnv({ TRIGGER_MAX_PER_TICK: '2.5' });
  assert.ok(float.errors.includes('INVALID_NUMERIC_TRIGGER_MAX_PER_TICK'));

  const good = validateEnv({ TRIGGER_CONCURRENCY: '4', WORKER_RETRY_BACKOFF_MS: '0', TRIGGER_MAX_RETRIES: '3' });
  assert.equal(good.errors.length, 0);
});

test('validateEnv warns on an unrecognised provider name (fail-closed trap)', () => {
  const result = validateEnv({ STT_PROVIDER: 'whisper9000', TTS_PROVIDER: 'elevenlabs' });
  assert.ok(result.warnings.includes('UNKNOWN_STT_PROVIDER_VALUE'));
  assert.ok(!result.warnings.includes('UNKNOWN_TTS_PROVIDER_VALUE'), 'a supported provider must not warn');
  assert.equal(result.errors.length, 0);
});

/* ------------------------------ Observability ----------------------------- */

test('collectMetrics reports artifact and scheduled-trigger health', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const runId = id('run');
    db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, seedData.tenantId, 'completed', '{}', 1, now(), now());
    db.run('INSERT INTO artifacts(id,run_id,path,sha256,size_bytes,kind,created_at) VALUES(?,?,?,?,?,?,?)', id('artifact'), runId, 'out/a.docx', 'x', 2048, 'document', now());
    db.run('INSERT INTO artifacts(id,run_id,path,sha256,size_bytes,kind,created_at) VALUES(?,?,?,?,?,?,?)', id('artifact'), runId, 'out/b.xlsx', 'y', 1024, 'spreadsheet', now());
    db.run('INSERT INTO scheduled_triggers(id,tenant_id,project_id,workspace_id,created_by,name,kind,schedule,goal,payload_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id('trigger'), seedData.tenantId, seedData.projectId, seedData.workspaceId, seedData.userId, 't1', 'interval', '15m', 'g', '{}', 1, new Date(Date.now() - 60_000).toISOString(), now(), now());
    db.run('INSERT INTO scheduled_triggers(id,tenant_id,project_id,workspace_id,created_by,name,kind,schedule,goal,payload_json,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id('trigger'), seedData.tenantId, seedData.projectId, seedData.workspaceId, seedData.userId, 't2', 'interval', '1h', 'g', '{}', 0, null, now(), now());

    const metrics = collectMetrics(db, { windowHours: 24 });
    assert.equal(metrics.artifacts.total, 2);
    assert.equal(metrics.artifacts.bytes, 3072);
    assert.equal(metrics.artifacts.byKind.document, 1);
    assert.equal(metrics.artifacts.byKind.spreadsheet, 1);
    assert.equal(metrics.triggers.total, 2);
    assert.equal(metrics.triggers.enabled, 1);
    assert.equal(metrics.triggers.due, 1);

    const text = renderPrometheus(metrics, { runSuccessRatio: 1, runSuccessTarget: 0.95, runSuccessMet: true, toolSuccessRatio: 1, toolSuccessTarget: 0.98, toolSuccessMet: true });
    assert.match(text, /semo0o_artifacts_total\{kind="document"\} 1/);
    assert.match(text, /semo0o_artifact_bytes_total 3072/);
    assert.match(text, /semo0o_scheduled_triggers_total\{state="enabled"\} 1/);
    assert.match(text, /semo0o_scheduled_triggers_total\{state="disabled"\} 1/);
    assert.match(text, /semo0o_scheduled_triggers_due 1/);
    // Every emitted line must still be valid Prometheus exposition text.
    for (const line of text.trim().split('\n')) {
      if (line.startsWith('#')) continue;
      assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d+(\.\d+)?$/);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
