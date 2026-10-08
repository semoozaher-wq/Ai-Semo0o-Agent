import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { RunQueue } from '../queue/queue.mjs';

/**
 * Production safety / recovery hardening for the run queue: duplicate active-run
 * protection (idempotent double-submit) and crash/restart orphan reconciliation.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-queue-'));

function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Queue Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'queue@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Queue Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  return { tenantId, userId, projectId, workspaceId };
}

function seedTask(db, seedData, goal = 'g') {
  const taskId = id('task');
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, seedData.tenantId, seedData.projectId, seedData.workspaceId, seedData.userId, goal, 'queued', now(), now());
  return taskId;
}

/* ---------------------- duplicate active-run protection ------------------- */

test('dedupeActive returns the existing active run for a double-submit of the same task and kind', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5 });
    const first = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'code.run' }, kind: 'code.run', dedupeActive: true });
    const second = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'code.run' }, kind: 'code.run', dedupeActive: true });
    assert.equal(second.id, first.id, 'the duplicate must resolve to the existing run');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM runs WHERE task_id=?', taskId).n, 1, 'no second run row may be created');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('dedupeActive still allows a different kind on the same task', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5 });
    const first = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'code.run' }, kind: 'code.run', dedupeActive: true });
    const other = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'multi.agent' }, kind: 'multi.agent', dedupeActive: true });
    assert.notEqual(other.id, first.id, 'a different kind is not a duplicate');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('dedupeActive permits a new run once the previous run is terminal', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5 });
    const first = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'code.run' }, kind: 'code.run', dedupeActive: true });
    db.run("UPDATE runs SET status='completed' WHERE id=?", first.id);
    const next = queue.enqueue({ taskId, tenantId: seedData.tenantId, payload: { kind: 'code.run' }, kind: 'code.run', dedupeActive: true });
    assert.notEqual(next.id, first.id, 'a terminal run no longer blocks a new submission');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* -------------------------- crash/restart recovery ------------------------ */

test('sweep re-queues a retryable run whose lease expired', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 3 });
    const runId = id('run');
    const past = new Date(Date.now() - 60_000).toISOString();
    db.run("INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,worker_id,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", runId, taskId, seedData.tenantId, 'running', JSON.stringify({ kind: 'code.run' }), 1, 'worker_dead', past, past, past);

    const summary = await queue.sweep();
    assert.equal(summary.requeued, 1);
    assert.equal(summary.finalized, 0);
    const row = db.get('SELECT * FROM runs WHERE id=?', runId);
    assert.equal(row.status, 'queued');
    assert.equal(row.worker_id, null);
    assert.equal(row.lease_until, null);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('sweep finalizes an orphaned run that can no longer be retried', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 3 });
    const runId = id('run');
    const past = new Date(Date.now() - 60_000).toISOString();
    db.run("INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,worker_id,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", runId, taskId, seedData.tenantId, 'running', JSON.stringify({ kind: 'code.run' }), 3, 'worker_dead', past, past, past);
    // In the real flow `tick()` moves the task to `running` when it claims the run.
    db.run("UPDATE tasks SET status='running' WHERE id=?", taskId);

    const summary = await queue.sweep();
    assert.equal(summary.requeued, 0);
    assert.equal(summary.finalized, 1);
    const row = db.get('SELECT * FROM runs WHERE id=?', runId);
    assert.equal(row.status, 'failed');
    assert.equal(JSON.parse(row.result_json).error, 'ORPHANED_RUN_RECOVERED');
    // The owning task is reconciled too, and an audit trail is written.
    assert.equal(db.get('SELECT status FROM tasks WHERE id=?', taskId).status, 'failed');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM audit_logs WHERE resource_id=? AND action=?', runId, 'run.recovered_orphan').n, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('sweep leaves an actively-leased run untouched', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 3 });
    const runId = id('run');
    const future = new Date(Date.now() + 600_000).toISOString();
    db.run("INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,worker_id,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", runId, taskId, seedData.tenantId, 'running', JSON.stringify({ kind: 'code.run' }), 1, 'worker_live', future, now(), now());

    const summary = await queue.sweep();
    assert.equal(summary.requeued, 0);
    assert.equal(summary.finalized, 0);
    assert.equal(db.get('SELECT status FROM runs WHERE id=?', runId).status, 'running');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recover() delegates to sweep() and returns the same reconciliation summary', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const taskId = seedTask(db, seedData);
    const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 2 });
    const past = new Date(Date.now() - 60_000).toISOString();
    db.run("INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,worker_id,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id('run'), taskId, seedData.tenantId, 'running', JSON.stringify({ kind: 'code.run' }), 2, 'worker_dead', past, past, past);

    const summary = await queue.recover();
    assert.deepEqual(Object.keys(summary).sort(), ['finalized', 'requeued']);
    assert.equal(summary.finalized, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
