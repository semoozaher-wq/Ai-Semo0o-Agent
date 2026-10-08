import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

/**
 * End-to-end proof that the Experience Engine now steers STRATEGY selection —
 * not just model/tool routing.
 *
 * A tenant whose own history shows multi-agent reliably beats single-agent for
 * the "code" task type must have a subsequent DEFAULT run (no `multiAgent` flag)
 * automatically executed as multi-agent. An explicit `multiAgent:false` must
 * always be able to opt out.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-exp-strategy-'));

/**
 * A hybrid scripted LLM: multi-agent nodes (messages carrying `node.kind`) get a
 * short final answer; the single-agent planner loop gets a one-step plan on its
 * opening turn and "done" on every later turn. Stateless, so it is unaffected by
 * how many multi-agent calls ran before it.
 */
function hybridLLM() {
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete({ messages = [] }) {
      const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
      const user = messages.find((message) => message.role === 'user')?.content ?? '{}';
      let payload = {};
      try { payload = JSON.parse(user); } catch { payload = {}; }
      const kind = payload?.node?.kind;
      if (kind) {
        return { provider: 'test', model: 'test', text: `${kind} done`, toolCalls: [], usage };
      }
      // Single-agent planner: the opening turn has neither a step nor outputs.
      if (!payload.step && !payload.outputs) {
        return { provider: 'test', model: 'test', text: JSON.stringify({ reasoning: 'read', steps: [{ id: 'step_1', title: 'Read', toolId: 'files.read', args: { path: 'input.txt' } }] }), toolCalls: [], usage };
      }
      return { provider: 'test', model: 'test', text: 'done', toolCalls: [], usage };
    },
  };
}

/** Seed a terminal run for a tenant, tagged with a task type and strategy. */
function seedStrategyRun(db, tenantId, userId, projectId, workspaceId, taskId, { status, multiAgent }) {
  const t = new Date().toISOString();
  const runId = id('run');
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, status, '{}', 1, t, t);
  db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, tenantId, 'routing_decision', JSON.stringify({ taskType: 'code' }), t);
  if (multiAgent) {
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, tenantId, 'planning_started', JSON.stringify({ multiAgent: true }), t);
  }
  db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('usage'), runId, tenantId, multiAgent ? 'multi-agent' : 'anthropic', 'claude-sonnet-4-6', 0, 0, 100, 0.4, t);
  return runId;
}

async function makeHarness() {
  const dir = await temp();
  await writeFile(path.join(dir, 'input.txt'), 'e2e strategy workspace');
  const db = new Database(path.join(dir, 'strategy.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const llm = hybridLLM();
  const tools = createLiveToolRegistry({ db, llm, getWorkspaceRoot: () => dir });
  const app = createApp({ db, queue, llm, liveTools: tools });
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
  const teardown = async () => {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, db, queue, app, request, teardown };
}

async function waitForTerminal(request, runId, token) {
  const terminal = new Set(['completed', 'completed_with_warnings', 'failed', 'blocked', 'cancelled', 'unverified']);
  let finished = { body: { status: 'queued' } };
  for (let i = 0; i < 500; i += 1) {
    finished = await request(`/runs/${runId}`, { token });
    if (terminal.has(finished.body.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return finished;
}

test('E2E: learned strategy flips a default run to multi-agent; explicit opt-out is respected', async () => {
  const h = await makeHarness();
  try {
    const email = `exp-strategy-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const registered = await h.request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: 'Strategy' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const account = h.db.get('SELECT id, tenant_id FROM users WHERE email=?', email);

    const project = await h.request('/projects', { method: 'POST', token, body: { name: 'Strategy Project', rootPath: h.dir } });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const { projectId, workspaceId } = project.body;

    // Give the tenant history where multi-agent WINS and single-agent LOSES for "code".
    const t = new Date().toISOString();
    const taskId = id('task');
    h.db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, account.tenant_id, projectId, workspaceId, account.id, 'history', 'completed', t, t);
    for (let i = 0; i < 3; i += 1) seedStrategyRun(h.db, account.tenant_id, account.id, projectId, workspaceId, taskId, { status: 'completed', multiAgent: true });
    for (let i = 0; i < 3; i += 1) seedStrategyRun(h.db, account.tenant_id, account.id, projectId, workspaceId, taskId, { status: 'failed', multiAgent: false });

    // A DEFAULT run (no multiAgent flag) must be selected as multi-agent by experience.
    const created = await h.request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId, workspaceId, goal: 'Fix the bug in the code', model: 'test' } });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    h.queue.start();
    const finished = await waitForTerminal(h.request, created.body.runId, token);
    assert.ok(['completed', 'completed_with_warnings'].includes(finished.body.status), `run should succeed (got ${finished.body.status})`);
    assert.equal(finished.body.result.multiAgent, true, 'the run was executed as multi-agent because experience proved it wins');

    const selected = h.db.all("SELECT payload_json FROM run_events WHERE run_id=? AND type='strategy_selected'", created.body.runId);
    assert.equal(selected.length, 1, 'exactly one strategy_selected event must be emitted');
    const payload = JSON.parse(selected[0].payload_json);
    assert.equal(payload.strategy, 'multi-agent');
    assert.equal(payload.source, 'experience');
    assert.equal(payload.taskType, 'code');
    assert.ok(payload.confidence >= 0.6);

    // An explicit `multiAgent:false` run must NOT be flipped by experience.
    const optedOut = await h.request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId, workspaceId, goal: 'Fix the bug in the code', model: 'test', multiAgent: false } });
    assert.equal(optedOut.status, 202, JSON.stringify(optedOut.body));
    const optedFinished = await waitForTerminal(h.request, optedOut.body.runId, token);
    assert.ok(['completed', 'completed_with_warnings'].includes(optedFinished.body.status), `opt-out run should succeed (got ${optedFinished.body.status})`);
    assert.notEqual(optedFinished.body.result?.multiAgent, true, 'explicit opt-out must stay single-agent');
    assert.equal(h.db.all("SELECT 1 FROM run_events WHERE run_id=? AND type='strategy_selected'", optedOut.body.runId).length, 0);
  } finally {
    await h.teardown();
  }
});

test('E2E: a tenant with no history is never flipped (single-agent, exactly as before)', async () => {
  const h = await makeHarness();
  try {
    const email = `exp-nohist-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const registered = await h.request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: 'NoHist' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const project = await h.request('/projects', { method: 'POST', token, body: { name: 'NoHist Project', rootPath: h.dir } });
    assert.equal(project.status, 201, JSON.stringify(project.body));

    const created = await h.request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'Fix the bug in the code', model: 'test' } });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    h.queue.start();
    const finished = await waitForTerminal(h.request, created.body.runId, token);
    assert.ok(['completed', 'completed_with_warnings'].includes(finished.body.status), `run should succeed (got ${finished.body.status})`);
    assert.notEqual(finished.body.result?.multiAgent, true, 'with no history the run stays single-agent');
    assert.equal(h.db.all("SELECT 1 FROM run_events WHERE run_id=? AND type='strategy_selected'", created.body.runId).length, 0);
  } finally {
    await h.teardown();
  }
});
