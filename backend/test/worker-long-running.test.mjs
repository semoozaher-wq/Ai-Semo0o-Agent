import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { createWorkerRuntime } from '../worker.mjs';

// A planner LLM whose planning turn deliberately outlives the run's wall-clock
// budget. The runtime computes `deadline = Date.now() + timeoutMs` BEFORE it
// plans, so a slow plan pushes the very next budget guard past the deadline —
// exactly the bounded, resumable stop that long-running autonomy must turn into
// a continuation instead of a failure. This is the same code path the server
// uses, so the assertion below is a real server/worker parity check.
function slowPlannerLLM({ planDelayMs = 600 } = {}) {
  let calls = 0;
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete() {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, planDelayMs));
        return {
          provider: 'test',
          text: JSON.stringify({
            reasoning: 'scan',
            steps: [{ id: 'step_1', title: 'Scan workspace', toolId: 'files.scan', args: { scope: '.', maxFiles: 20 } }],
          }),
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        };
      }
      return { provider: 'test', text: '', toolCalls: [], usage: {} };
    },
  };
}

// Seed the minimal tenant/user/project/workspace/task graph a run needs.
function seed(db, rootPath) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Worker LR Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'worker-lr@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Worker LR Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, rootPath, t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'long worker goal', 'queued', t, t);
  return { tenantId, taskId };
}

test('worker: a bounded wall-clock stop schedules a continuation (server/worker parity)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-worker-lr-'));
  const workspaceDir = path.join(dir, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const db = new Database(path.join(dir, 'worker-lr.sqlite'));
  try {
    const { tenantId, taskId } = seed(db, workspaceDir);
    const { queue } = createWorkerRuntime({ db, llm: slowPlannerLLM(), secrets: [] });

    // A generous budget so setup + the first budget guard always pass, but far
    // shorter than the planner's delay so the *step* guard trips on the deadline.
    const original = queue.enqueue({ taskId, tenantId, kind: 'agent.run', payload: { goal: 'long worker goal', timeoutMs: 150 } });
    await queue.tick();

    // The bounded stop is terminal-with-warnings (never a failure) — the same
    // terminal state the server produces for the identical scenario.
    const stored = db.get('SELECT * FROM runs WHERE id=?', original.id);
    assert.equal(stored.status, 'completed_with_warnings', 'a bounded stop must be terminal-with-warnings, never a failure');
    const result = JSON.parse(stored.result_json);
    assert.equal(result.continuation.scheduled, true, 'the worker must schedule a continuation exactly like the server');
    assert.ok(result.continuation.runId, 'a continuation run id must be recorded');

    // A NEW run on the SAME task resumes from the durable checkpoint.
    const next = db.get('SELECT * FROM runs WHERE id=?', result.continuation.runId);
    assert.ok(next, 'continuation run must exist');
    assert.equal(next.task_id, taskId);
    assert.equal(next.tenant_id, tenantId);
    assert.equal(next.status, 'queued');
    const nextPayload = JSON.parse(next.payload_json);
    assert.equal(nextPayload.resumeFrom, 0, 'no step completed, so the continuation resumes from step 0');
    assert.equal(nextPayload.continuations, 1);
    assert.equal(nextPayload.parentRunId, original.id);
    assert.equal(nextPayload.continuationReason, 'AGENT_TIME_LIMIT_EXCEEDED');
    assert.equal(nextPayload.kind, 'agent.run');

    // The task stays queued while the continuation is outstanding (never terminal).
    const task = db.get('SELECT status FROM tasks WHERE id=?', taskId);
    assert.equal(task.status, 'queued', 'the task stays queued while the continuation is outstanding');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker: long-running wiring matches the server (supervisor wraps agent.run, bounded by AGENT_MAX_CONTINUATIONS)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-worker-parity-'));
  const workspaceDir = path.join(dir, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  const db = new Database(path.join(dir, 'worker-parity.sqlite'));
  try {
    const { tenantId, taskId } = seed(db, workspaceDir);
    const { queue } = createWorkerRuntime({ db, llm: slowPlannerLLM(), secrets: [] });

    // The agent.run handler is registered (supervisor-wrapped) — the exact same
    // registration the in-process server performs in `createApp`.
    assert.equal(typeof queue.handlers.get('agent.run'), 'function');

    // Exhaust the continuation budget: the run must stop continuing and never
    // loop forever, reported as a terminal `completed_with_warnings`.
    const original = queue.enqueue({ taskId, tenantId, kind: 'agent.run', payload: { goal: 'long worker goal', timeoutMs: 150, continuations: 5 } });
    await queue.tick();
    const stored = db.get('SELECT * FROM runs WHERE id=?', original.id);
    assert.equal(stored.status, 'completed_with_warnings');
    const result = JSON.parse(stored.result_json);
    assert.equal(result.continuation.scheduled, false);
    assert.equal(result.continuation.reason, 'continuation_limit_reached');
    // No extra run was created once the bound was reached.
    const count = db.get('SELECT COUNT(*) AS n FROM runs WHERE task_id=?', taskId).n;
    assert.equal(count, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
