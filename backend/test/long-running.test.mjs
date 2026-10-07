import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { RunQueue } from '../queue/queue.mjs';
import {
  ContinuationSupervisor,
  createContinuationSupervisor,
  isBoundedLimitError,
  parseCheckpoint,
} from '../agent/long-running.mjs';

// Seed the minimal tenant/user/project/workspace/task graph a run needs.
function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'LR Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'lr@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'LR Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'long goal', 'queued', t, t);
  return { tenantId, taskId };
}

async function fixture({ maxContinuations = 5 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-longrun-'));
  const db = new Database(path.join(dir, 'longrun.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const { tenantId, taskId } = seed(db);
  const supervisor = createContinuationSupervisor({ db, queue, maxContinuations });
  return {
    dir, db, queue, supervisor, tenantId, taskId,
    close: async () => { queue.stop(); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

const PLAN = { goal: 'long goal', steps: [{ id: 's1' }, { id: 's2' }, { id: 's3' }, { id: 's4' }] };

/* --------------------------- pure helpers -------------------------------- */

test('long-running: parseCheckpoint reads the durable {plan, stepIndex}', () => {
  assert.equal(parseCheckpoint(null), null);
  assert.equal(parseCheckpoint('not json'), null);
  assert.equal(parseCheckpoint('123'), null);
  const parsed = parseCheckpoint(JSON.stringify({ plan: PLAN, stepIndex: 2 }));
  assert.equal(parsed.stepIndex, 2);
  assert.deepEqual(parsed.plan, PLAN);
  // Negative / fractional / missing stepIndex are clamped to a safe integer.
  assert.equal(parseCheckpoint(JSON.stringify({ plan: null, stepIndex: -4 })).stepIndex, 0);
  assert.equal(parseCheckpoint(JSON.stringify({ plan: null, stepIndex: 2.9 })).stepIndex, 2);
  assert.equal(parseCheckpoint(JSON.stringify({ plan: null })).stepIndex, 0);
});

test('long-running: only a resumable bounded limit qualifies for continuation', () => {
  assert.equal(isBoundedLimitError(new Error('AGENT_TIME_LIMIT_EXCEEDED')), true);
  // Structural caps must stay hard failures so a fresh run cannot loop forever.
  assert.equal(isBoundedLimitError(new Error('AGENT_STEP_LIMIT_EXCEEDED')), false);
  assert.equal(isBoundedLimitError(new Error('AGENT_TOOL_CALL_LIMIT_EXCEEDED')), false);
  assert.equal(isBoundedLimitError(new Error('AGENT_LOOP_DETECTED')), false);
  assert.equal(isBoundedLimitError('AGENT_TIME_LIMIT_EXCEEDED'), true);
  assert.equal(isBoundedLimitError(undefined), false);
});

test('long-running: shouldContinue requires a continuation status, budget and checkpoint', async () => {
  const fx = await fixture({ maxContinuations: 2 });
  try {
    const run = fx.queue.enqueue({ taskId: fx.taskId, tenantId: fx.tenantId, kind: 'agent.run', payload: {} });
    // No checkpoint yet -> cannot resume.
    assert.equal(fx.supervisor.shouldContinue(run, { status: 'continuation' }), false);
    fx.db.run('UPDATE runs SET checkpoint_json=? WHERE id=?', JSON.stringify({ plan: PLAN, stepIndex: 2 }), run.id);
    const withCheckpoint = fx.db.get('SELECT * FROM runs WHERE id=?', run.id);
    // A normal terminal result never continues.
    assert.equal(fx.supervisor.shouldContinue(withCheckpoint, { status: 'completed' }), false);
    // A continuation with a checkpoint does continue.
    assert.equal(fx.supervisor.shouldContinue(withCheckpoint, { status: 'continuation' }), true);
    // Once the continuation budget is exhausted it stops.
    fx.db.run('UPDATE runs SET payload_json=? WHERE id=?', JSON.stringify({ kind: 'agent.run', continuations: 2 }), run.id);
    const exhausted = fx.db.get('SELECT * FROM runs WHERE id=?', run.id);
    assert.equal(fx.supervisor.continuationsFor(exhausted), 2);
    assert.equal(fx.supervisor.shouldContinue(exhausted, { status: 'continuation' }), false);
  } finally {
    await fx.close();
  }
});

/* --------------------------- durable resume ------------------------------ */

test('long-running: a bounded stop schedules a durable continuation that resumes from the checkpoint', async () => {
  const fx = await fixture({ maxContinuations: 5 });
  try {
    const original = fx.queue.enqueue({ taskId: fx.taskId, tenantId: fx.tenantId, kind: 'agent.run', payload: { goal: 'long goal' } });
    // The runtime checkpoints progress and returns a transient `continuation`.
    const handler = async ({ run }) => {
      fx.db.run('UPDATE runs SET checkpoint_json=? WHERE id=?', JSON.stringify({ plan: PLAN, stepIndex: 2 }), run.id);
      return { status: 'continuation', reason: 'AGENT_TIME_LIMIT_EXCEEDED', usage: { totalTokens: 10 }, outputs: ['partial'] };
    };
    fx.queue.register('agent.run', fx.supervisor.wrap(handler));
    await fx.queue.tick();

    // The original run is terminal (never left in a non-terminal `continuation`).
    const stored = fx.db.get('SELECT * FROM runs WHERE id=?', original.id);
    assert.equal(stored.status, 'completed_with_warnings');
    const result = JSON.parse(stored.result_json);
    assert.equal(result.continuation.scheduled, true);
    assert.ok(result.continuation.runId);
    assert.equal(result.continuation.continuations, 1);

    // A NEW run on the SAME task resumes from the checkpoint.
    const next = fx.db.get('SELECT * FROM runs WHERE id=?', result.continuation.runId);
    assert.ok(next, 'continuation run must exist');
    assert.equal(next.task_id, fx.taskId);
    assert.equal(next.tenant_id, fx.tenantId);
    assert.equal(next.status, 'queued');
    const nextPayload = JSON.parse(next.payload_json);
    assert.equal(nextPayload.resumeFrom, 2, 'must resume from the checkpointed step index');
    assert.equal(nextPayload.continuations, 1);
    assert.equal(nextPayload.parentRunId, original.id);
    assert.equal(nextPayload.continuationReason, 'AGENT_TIME_LIMIT_EXCEEDED');
    assert.equal(nextPayload.kind, 'agent.run');

    // The task stays queued while the continuation is outstanding (never terminal).
    const task = fx.db.get('SELECT status FROM tasks WHERE id=?', fx.taskId);
    assert.equal(task.status, 'queued');
  } finally {
    await fx.close();
  }
});

test('long-running: continuations are bounded and never loop forever', async () => {
  const fx = await fixture({ maxContinuations: 2 });
  try {
    const original = fx.queue.enqueue({ taskId: fx.taskId, tenantId: fx.tenantId, kind: 'agent.run', payload: { continuations: 2 } });
    fx.db.run('UPDATE runs SET checkpoint_json=? WHERE id=?', JSON.stringify({ plan: PLAN, stepIndex: 1 }), original.id);
    let ran = false;
    const handler = async () => { ran = true; return { status: 'continuation', reason: 'AGENT_TIME_LIMIT_EXCEEDED' }; };
    fx.queue.register('agent.run', fx.supervisor.wrap(handler));
    await fx.queue.tick();

    assert.equal(ran, true);
    const stored = fx.db.get('SELECT * FROM runs WHERE id=?', original.id);
    assert.equal(stored.status, 'completed_with_warnings');
    const result = JSON.parse(stored.result_json);
    assert.equal(result.continuation.scheduled, false);
    assert.equal(result.continuation.reason, 'continuation_limit_reached');
    assert.equal(result.continuation.limit, 2);
    // No extra run was created.
    const count = fx.db.get('SELECT COUNT(*) AS n FROM runs WHERE task_id=?', fx.taskId).n;
    assert.equal(count, 1);
  } finally {
    await fx.close();
  }
});

test('long-running: a normal terminal result passes through the supervisor untouched', async () => {
  const fx = await fixture();
  try {
    const original = fx.queue.enqueue({ taskId: fx.taskId, tenantId: fx.tenantId, kind: 'agent.run', payload: {} });
    fx.queue.register('agent.run', fx.supervisor.wrap(async () => ({ status: 'completed', outputs: ['done'] })));
    await fx.queue.tick();
    const stored = fx.db.get('SELECT * FROM runs WHERE id=?', original.id);
    assert.equal(stored.status, 'completed');
    const result = JSON.parse(stored.result_json);
    assert.equal(result.continuation, undefined);
    assert.deepEqual(result.outputs, ['done']);
  } finally {
    await fx.close();
  }
});

test('long-running: a supervisor failure never turns a finished run into a failure', async () => {
  const fx = await fixture();
  try {
    const original = fx.queue.enqueue({ taskId: fx.taskId, tenantId: fx.tenantId, kind: 'agent.run', payload: {} });
    fx.db.run('UPDATE runs SET checkpoint_json=? WHERE id=?', JSON.stringify({ plan: PLAN, stepIndex: 1 }), original.id);
    // Force `continue` to throw by removing the queue's enqueue capability.
    const broken = new ContinuationSupervisor({ db: fx.db, queue: { enqueue() { throw new Error('QUEUE_DOWN'); } }, maxContinuations: 5 });
    fx.queue.register('agent.run', broken.wrap(async () => ({ status: 'continuation', reason: 'AGENT_TIME_LIMIT_EXCEEDED' })));
    await fx.queue.tick();
    const stored = fx.db.get('SELECT * FROM runs WHERE id=?', original.id);
    assert.equal(stored.status, 'completed_with_warnings');
    const result = JSON.parse(stored.result_json);
    assert.equal(result.continuation.scheduled, false);
    assert.equal(result.continuation.reason, 'supervisor_error');
    assert.match(result.continuation.error, /QUEUE_DOWN/);
  } finally {
    await fx.close();
  }
});

test('long-running: supervisor validates its dependencies', () => {
  assert.throws(() => new ContinuationSupervisor({ queue: {} }), /DB_REQUIRED/);
  assert.throws(() => new ContinuationSupervisor({ db: {} }), /QUEUE_REQUIRED/);
  assert.throws(() => createContinuationSupervisor({ db: {}, queue: { enqueue() {} } }).wrap(null), /HANDLER_REQUIRED/);
});
