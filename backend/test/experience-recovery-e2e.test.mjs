import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';

/**
 * End-to-end proof that the Experience Engine now steers the EXECUTION METHOD
 * (retry budget) and RECOVERY action — not just model/tool routing.
 *
 * A tenant whose history shows a tool is proven-flaky for a task type AND that
 * replanning rescues the failure while repairing does not, must have a
 * subsequent failing run (a) fail fast instead of burning retries and (b) go
 * straight to the replan path, both surfaced as explicit events.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-exp-recovery-'));

function scriptedLLM() {
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete({ messages = [] }) {
      const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages.find((message) => message.role === 'user')?.content ?? '{}';
      let payload = {};
      try { payload = JSON.parse(user); } catch { payload = {}; }
      // The recovery planner is asked for a recovery plan: refuse to produce one
      // so the run deterministically ends after the learned recovery decision.
      if (system.includes('recovery plan')) return { provider: 'test', model: 'test', text: 'no recovery', toolCalls: [], usage };
      // Opening planning turn -> a one-step plan that will fail.
      if (!payload.step && !payload.outputs) {
        return { provider: 'test', model: 'test', text: JSON.stringify({ reasoning: 'read', steps: [{ id: 'step_1', title: 'Read', toolId: 'files.read', args: { path: 'input.txt' } }] }), toolCalls: [], usage };
      }
      return { provider: 'test', model: 'test', text: 'done', toolCalls: [], usage };
    },
  };
}

/** Seed one terminal run with a task type, an optional recovery event and tool calls. */
function seedRun(db, tenantId, taskId, { status, taskType = 'code', recovery = null, tools = [] }) {
  const t = new Date().toISOString();
  const runId = id('run');
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, status, '{}', 1, t, t);
  db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, tenantId, 'routing_decision', JSON.stringify({ taskType }), t);
  if (recovery) {
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, tenantId, 'self_healing', JSON.stringify(recovery), t);
  }
  for (const [toolId, toolStatus] of tools) {
    db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,status,created_at) VALUES(?,?,?,?,?,?)', id('tc'), runId, toolId, '{}', toolStatus, t);
  }
  return runId;
}

test('E2E: learned execution + recovery steer a failing run (fail-fast retries + replan-first)', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'recovery.sqlite'));
  // maxAttempts:1 so the (intentionally) failing run reaches a terminal state on
  // the first attempt instead of being retried by the queue.
  const queue = new RunQueue(db, { pollMs: 5, maxAttempts: 1 });
  const llm = scriptedLLM();
  // A tool registry whose only tool always fails with a TOOL_FAILURE-classified error.
  const liveTools = { run: async () => ({ ok: false, output: null, error: 'tool exploded' }) };
  const app = createApp({ db, queue, llm, liveTools });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  try {
    const email = `exp-recovery-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const registered = await request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: 'Recovery' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const account = db.get('SELECT id, tenant_id FROM users WHERE email=?', email);

    const project = await request('/projects', { method: 'POST', token, body: { name: 'Recovery Project', rootPath: dir } });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const { projectId, workspaceId } = project.body;

    const t = new Date().toISOString();
    const taskId = id('task');
    db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, account.tenant_id, projectId, workspaceId, account.id, 'history', 'completed', t, t);

    // History: replan rescued every failure; repair never did. files.read is
    // proven flaky for the "code" task type (12 calls, 0 successes).
    for (let i = 0; i < 3; i += 1) {
      seedRun(db, account.tenant_id, taskId, { status: 'completed', recovery: { action: 'replan', failureKind: 'TOOL_FAILURE' }, tools: [['files.read', 'failed'], ['files.read', 'failed']] });
    }
    for (let i = 0; i < 3; i += 1) {
      seedRun(db, account.tenant_id, taskId, { status: 'failed', recovery: { action: 'repair', failureKind: 'TOOL_FAILURE' }, tools: [['files.read', 'failed'], ['files.read', 'failed']] });
    }

    const created = await request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId, workspaceId, goal: 'Fix the bug in the code', model: 'test' } });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    queue.start();

    const terminal = new Set(['completed', 'completed_with_warnings', 'failed', 'blocked', 'cancelled', 'unverified']);
    let finished = { body: { status: 'queued' } };
    for (let i = 0; i < 500; i += 1) {
      finished = await request(`/runs/${created.body.runId}`, { token });
      if (terminal.has(finished.body.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(terminal.has(finished.body.status), `run should finish (got ${finished.body.status})`);

    // Execution method: the proven-flaky tool's retry budget was cut to 1.
    const execGuided = db.all("SELECT payload_json FROM run_events WHERE run_id=? AND type='execution_guided'", created.body.runId);
    assert.equal(execGuided.length, 1, 'execution_guided must be emitted for the proven-flaky tool');
    const execPayload = JSON.parse(execGuided[0].payload_json);
    assert.equal(execPayload.toolId, 'files.read');
    assert.equal(execPayload.taskType, 'code');
    assert.equal(execPayload.retries, 1, 'retries were reduced to 1');
    assert.ok(execPayload.base > 1, 'the base budget was higher than 1');

    // Recovery: experience chose replan over the futile repair.
    const recGuided = db.all("SELECT payload_json FROM run_events WHERE run_id=? AND type='recovery_guided'", created.body.runId);
    assert.equal(recGuided.length, 1, 'recovery_guided must be emitted for the learned recovery action');
    const recPayload = JSON.parse(recGuided[0].payload_json);
    assert.equal(recPayload.action, 'replan');
    assert.equal(recPayload.failureKind, 'TOOL_FAILURE');
    assert.equal(recPayload.source, 'experience');
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
