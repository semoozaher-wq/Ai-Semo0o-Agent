import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import {
  buildExperienceSnapshot,
  experienceGuidance,
  modelPriorFromSnapshot,
  summarizeExperience,
  toolReliabilityFromSnapshot,
  EXPERIENCE_VERSION,
} from '../agent/experience.mjs';
import { MaestroModelRouter } from '../models/task-router.mjs';

/**
 * Experience Engine — closes the learning loop.
 *
 * Every number here is derived from REAL SQLite rows (runs, run_usage,
 * run_events, tool_calls) so the aggregation is reproducible. The router tests
 * prove the prior only *nudges* the static policy in proportion to confidence,
 * and that with no prior (or no evidence) routing is byte-for-byte unchanged.
 */

const FIXED_NOW = new Date('2024-06-15T12:00:00.000Z');
const fixedNow = () => FIXED_NOW;
const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-exp-'));

function seedTenant(db, label = 'Exp') {
  const t = '2024-06-10T00:00:00.000Z';
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, `${label} Tenant`, t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, `${label.toLowerCase()}@test`, 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, `${label} Project`, t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  return { tenantId, userId, projectId, workspaceId };
}

function seedTask(db, seed, goal = 'g') {
  const taskId = id('task');
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, seed.tenantId, seed.projectId, seed.workspaceId, seed.userId, goal, 'completed', '2024-06-10T00:00:00.000Z', '2024-06-10T00:00:00.000Z');
  return taskId;
}

function seedRun(db, seed, taskId, { status = 'completed', createdAt = '2024-06-10T00:00:00.000Z', updatedAt = '2024-06-10T00:00:05.000Z', taskType = null } = {}) {
  const runId = id('run');
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, seed.tenantId, status, JSON.stringify({ kind: 'code.run' }), 1, createdAt, updatedAt);
  if (taskType) {
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, seed.tenantId, 'routing_decision', JSON.stringify({ taskType }), createdAt);
  }
  return runId;
}

function seedUsage(db, seed, runId, { model = 'claude-sonnet-4-6', provider = 'anthropic', tokens = 100, cost = 0.5, createdAt = '2024-06-10T00:00:02.000Z' } = {}) {
  db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('usage'), runId, seed.tenantId, provider, model, 0, 0, tokens, cost, createdAt);
}

function seedTool(db, runId, toolId, status) {
  db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,status,created_at) VALUES(?,?,?,?,?,?)', id('tc'), runId, toolId, '{}', status, '2024-06-10T00:00:01.000Z');
}

/**
 * Seed a small but representative history:
 *   code:      claude-sonnet-4-6 x2 (both succeed), gpt-5 x1 (fails)
 *   reasoning: gpt-5 x1 (succeeds)
 *   tools:     files.write 3 calls / 1 fail, shell.run 4 calls / 0 fail
 * Plus one non-terminal run and one unknown model that MUST be ignored.
 */
function seedHistory(db) {
  const seed = seedTenant(db);
  const taskId = seedTask(db, seed);

  const c1 = seedRun(db, seed, taskId, { status: 'completed', taskType: 'code', createdAt: '2024-06-10T00:00:00.000Z', updatedAt: '2024-06-10T00:00:05.000Z' });
  seedUsage(db, seed, c1, { model: 'claude-sonnet-4-6', provider: 'anthropic', tokens: 100, cost: 0.5 });
  const c2 = seedRun(db, seed, taskId, { status: 'completed', taskType: 'code', createdAt: '2024-06-10T01:00:00.000Z', updatedAt: '2024-06-10T01:00:05.000Z' });
  seedUsage(db, seed, c2, { model: 'claude-sonnet-4-6', provider: 'anthropic', tokens: 200, cost: 0.3 });
  const c3 = seedRun(db, seed, taskId, { status: 'failed', taskType: 'code', createdAt: '2024-06-10T02:00:00.000Z', updatedAt: '2024-06-10T02:00:05.000Z' });
  seedUsage(db, seed, c3, { model: 'gpt-5', provider: 'openai', tokens: 50, cost: 0.1 });
  const r1 = seedRun(db, seed, taskId, { status: 'completed', taskType: 'reasoning', createdAt: '2024-06-10T03:00:00.000Z', updatedAt: '2024-06-10T03:00:05.000Z' });
  seedUsage(db, seed, r1, { model: 'gpt-5', provider: 'openai', tokens: 80, cost: 0.2 });

  // Non-terminal run: must be excluded from the snapshot.
  const running = seedRun(db, seed, taskId, { status: 'running', taskType: 'code', createdAt: '2024-06-10T04:00:00.000Z', updatedAt: '2024-06-10T04:00:05.000Z' });
  seedUsage(db, seed, running, { model: 'claude-sonnet-4-6', provider: 'anthropic', tokens: 999, cost: 9 });
  // Unknown model: must be excluded from model observations.
  seedUsage(db, seed, c1, { model: 'totally-unknown-model', provider: 'x', tokens: 5, cost: 0 });

  seedTool(db, c1, 'files.write', 'ok');
  seedTool(db, c2, 'files.write', 'ok');
  seedTool(db, c3, 'files.write', 'failed');
  seedTool(db, c1, 'shell.run', 'ok');
  seedTool(db, c2, 'shell.run', 'ok');
  seedTool(db, c3, 'shell.run', 'ok');
  seedTool(db, r1, 'shell.run', 'ok');

  return seed;
}

/* ------------------------------ aggregation ------------------------------- */

test('buildExperienceSnapshot aggregates real rows into per-task-type model priors', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedHistory(db);
    const snapshot = buildExperienceSnapshot(db, { tenantId: seed.tenantId, now: fixedNow });

    assert.equal(snapshot.version, EXPERIENCE_VERSION);
    assert.equal(snapshot.tenantId, seed.tenantId);
    assert.equal(snapshot.sampleSize.runs, 4, 'only terminal runs are counted');
    assert.equal(snapshot.sampleSize.modelObservations, 4, 'the unknown model + non-terminal run are excluded');
    assert.equal(snapshot.sampleSize.toolCalls, 7);

    const code = snapshot.models.code;
    assert.ok(code['claude-sonnet-4-6']);
    assert.equal(code['claude-sonnet-4-6'].attempts, 2);
    assert.equal(code['claude-sonnet-4-6'].successes, 2);
    assert.equal(code['claude-sonnet-4-6'].successRate, 1);
    assert.equal(code['claude-sonnet-4-6'].smoothedSuccessRate, 0.75, '(2 + 1) / (2 + 2)');
    assert.equal(code['claude-sonnet-4-6'].confidence, 0.4, '2 of 5 observations');
    assert.equal(code['claude-sonnet-4-6'].avgTokens, 150);

    assert.equal(code['gpt-5'].attempts, 1);
    assert.equal(code['gpt-5'].successes, 0);
    assert.equal(code['gpt-5'].successRate, 0);
    assert.equal(code['gpt-5'].confidence, 0, 'one observation is below the confidence floor');
    assert.equal(code['totally-unknown-model'], undefined, 'unknown models never enter the prior');

    assert.equal(snapshot.models.reasoning['gpt-5'].successes, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildExperienceSnapshot aggregates tool reliability', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedHistory(db);
    const snapshot = buildExperienceSnapshot(db, { tenantId: seed.tenantId, now: fixedNow });

    assert.equal(snapshot.tools['files.write'].calls, 3);
    assert.equal(snapshot.tools['files.write'].failures, 1);
    assert.equal(snapshot.tools['files.write'].successRate, 0.6667);
    assert.equal(snapshot.tools['files.write'].smoothedSuccessRate, 0.6, '(2 + 1) / (3 + 2)');
    assert.equal(snapshot.tools['files.write'].confidence, 0.6);

    assert.equal(snapshot.tools['shell.run'].calls, 4);
    assert.equal(snapshot.tools['shell.run'].failures, 0);
    assert.equal(snapshot.tools['shell.run'].successRate, 1);
    assert.equal(snapshot.tools['shell.run'].confidence, 0.8);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildExperienceSnapshot enforces tenant isolation', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedA = seedHistory(db);
    const seedB = seedTenant(db, 'Other');
    const taskB = seedTask(db, seedB);
    const runB = seedRun(db, seedB, taskB, { status: 'completed', taskType: 'code' });
    seedUsage(db, seedB, runB, { model: 'gpt-5', provider: 'openai' });

    const snapshotA = buildExperienceSnapshot(db, { tenantId: seedA.tenantId, now: fixedNow });
    assert.equal(snapshotA.sampleSize.runs, 4, "tenant B's run must never leak into tenant A's snapshot");

    const snapshotB = buildExperienceSnapshot(db, { tenantId: seedB.tenantId, now: fixedNow });
    assert.equal(snapshotB.sampleSize.runs, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildExperienceSnapshot is fail-soft and empty for missing data', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedTenant(db);
    // No runs at all -> a valid, empty snapshot (never a throw).
    const empty = buildExperienceSnapshot(db, { tenantId: seed.tenantId, now: fixedNow });
    assert.equal(empty.sampleSize.runs, 0);
    assert.deepEqual(empty.models, {});
    assert.deepEqual(empty.tools, {});

    // Missing tenant -> empty snapshot, no crash.
    assert.equal(buildExperienceSnapshot(db, { now: fixedNow }).sampleSize.runs, 0);
    assert.equal(buildExperienceSnapshot(null, { tenantId: 'x' }).sampleSize.runs, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- derived prior shapes ------------------------- */

test('modelPriorFromSnapshot exposes the smoothed rate + confidence the router consumes', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedHistory(db);
    const prior = modelPriorFromSnapshot(buildExperienceSnapshot(db, { tenantId: seed.tenantId, now: fixedNow }));

    assert.deepEqual(prior.code['claude-sonnet-4-6'], { successRate: 0.75, confidence: 0.4, attempts: 2 });
    assert.deepEqual(prior.code['gpt-5'], { successRate: 0.3333, confidence: 0, attempts: 1 });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('toolReliabilityFromSnapshot exposes tool success rate + confidence', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedHistory(db);
    const reliability = toolReliabilityFromSnapshot(buildExperienceSnapshot(db, { tenantId: seed.tenantId, now: fixedNow }));
    assert.deepEqual(reliability['files.write'], { successRate: 0.6, confidence: 0.6, calls: 3 });
    assert.equal(reliability['shell.run'].successRate, 0.8333);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('experienceGuidance names the winning model and the risky/reliable tools', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedHistory(db);
    const snapshot = buildExperienceSnapshot(db, { tenantId: seed.tenantId, now: fixedNow });
    const lines = experienceGuidance(snapshot);

    assert.ok(lines.length >= 2);
    assert.ok(lines.some((line) => line.includes('claude-sonnet-4-6')), 'names the best code model');
    assert.ok(lines.some((line) => line.includes('files.write')), 'flags the flaky tool');
    assert.ok(lines.some((line) => line.includes('shell.run')), 'lists the reliable tool');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('summarizeExperience reports availability and sample size', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedHistory(db);
    const summary = summarizeExperience(buildExperienceSnapshot(db, { tenantId: seed.tenantId, now: fixedNow }));
    assert.equal(summary.available, true);
    assert.equal(summary.sampleSize.runs, 4);
    assert.equal(summary.taskTypes, 2);
    assert.equal(summary.tools, 2);
    assert.deepEqual(summarizeExperience(null), { available: false });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------- router: confidence gating ---------------------- */

test('router ignores an experience prior with zero confidence (static order preserved)', () => {
  const router = new MaestroModelRouter();
  const before = router.route({ taskType: 'code' }).model;
  // Strong signal but ZERO confidence (thin evidence) -> must not re-rank.
  router.setExperience({ code: { 'gpt-5': { successRate: 1, confidence: 0, attempts: 0 } } });
  assert.equal(router.route({ taskType: 'code' }).model, before, 'no confidence => no change');
  assert.equal(router.chain('code')[0], before);
});

test('router promotes a model that keeps succeeding for a task type', () => {
  const router = new MaestroModelRouter();
  const before = router.route({ taskType: 'code' }).model;
  assert.equal(before, 'claude-sonnet-4-6');

  router.setExperience({
    code: {
      'claude-sonnet-4-6': { successRate: 0, confidence: 1, attempts: 10 },
      'gpt-5': { successRate: 1, confidence: 1, attempts: 10 },
    },
  });

  const decision = router.route({ taskType: 'code' });
  assert.equal(decision.model, 'gpt-5', 'the proven model rises to the top');
  assert.equal(decision.experienceApplied, true);
  assert.ok(decision.experience && decision.experience.attempts === 10);
  assert.match(decision.reason, /experience=on/);
  // The curated cross-provider policy is preserved as the tail of the chain.
  assert.ok(decision.chain.includes('claude-sonnet-4-6'));
  assert.ok(decision.chain.length >= 3);
});

test('router with no prior is byte-for-byte the static policy', () => {
  const withPrior = new MaestroModelRouter();
  withPrior.setExperience({ code: { 'gpt-5': { successRate: 1, confidence: 1, attempts: 9 } } });
  const without = new MaestroModelRouter();
  const plain = without.route({ taskType: 'reasoning' });
  assert.equal(plain.experienceApplied, false, 'no prior for reasoning');
  assert.equal(plain.experience, null);
  assert.equal(plain.model, 'gpt-5');
});

test('fork carries the experience prior into an isolated health router', () => {
  const router = new MaestroModelRouter();
  router.setExperience({ code: { 'gpt-5': { successRate: 1, confidence: 1, attempts: 10 }, 'claude-sonnet-4-6': { successRate: 0, confidence: 1, attempts: 10 } } });
  const forked = router.fork();
  assert.equal(forked.route({ taskType: 'code' }).model, 'gpt-5', 'the fork keeps the same learned prior');
});

/* --------------------------- live run (runtime) --------------------------- */

// A minimal scripted LLM: call 1 = a one-step plan, call 2 = post-tool turn,
// call 3 = done. Enough to drive a full Maestro run.
function scriptedLLM() {
  let calls = 0;
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete() {
      calls += 1;
      const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
      if (calls === 1) return { provider: 'test', model: 'test', text: JSON.stringify({ reasoning: 'read', steps: [{ id: 'step_1', title: 'Read', toolId: 'files.read', args: { path: 'input.txt' } }] }), toolCalls: [], usage };
      if (calls === 2) return { provider: 'test', model: 'test', text: '', toolCalls: [], usage };
      return { provider: 'test', model: 'test', text: 'done', toolCalls: [], usage };
    },
  };
}

function seedTerminalRun(db, tenantId, userId, { taskType = 'code', model = 'claude-sonnet-4-6' } = {}) {
  const t = new Date().toISOString();
  const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task'); const runId = id('run');
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'hist', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'hist', 'completed', t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'completed', '{}', 1, t, t);
  db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, tenantId, 'routing_decision', JSON.stringify({ taskType }), t);
  db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('usage'), runId, tenantId, 'anthropic', model, 0, 0, 100, 0.5, t);
  return runId;
}

test('a live run learns from history: emits experience_applied + an experience-aware routing decision', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm: scriptedLLM(), liveTools: { run: async () => ({ ok: true, output: { content: 'ok' } }) } });
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
    const email = `exp-run-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const registered = await request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: 'Exp Run' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const account = db.get('SELECT id, tenant_id FROM users WHERE email=?', email);

    // Give the tenant real "code" history so the router has a prior to consume.
    seedTerminalRun(db, account.tenant_id, account.id, { taskType: 'code', model: 'claude-sonnet-4-6' });
    seedTerminalRun(db, account.tenant_id, account.id, { taskType: 'code', model: 'claude-sonnet-4-6' });

    const project = await request('/projects', { method: 'POST', token, body: { name: 'Exp Run Project', rootPath: dir } });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const created = await request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'Fix the bug in the code', model: 'test' } });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    queue.start();

    const terminal = new Set(['completed', 'completed_with_warnings', 'failed', 'blocked', 'cancelled', 'unverified']);
    let finished = { body: { status: 'queued' } };
    for (let i = 0; i < 400; i += 1) {
      finished = await request(`/runs/${created.body.runId}`, { token });
      if (terminal.has(finished.body.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(terminal.has(finished.body.status), `run should finish (got ${finished.body.status})`);

    const applied = db.all("SELECT payload_json FROM run_events WHERE run_id=? AND type='experience_applied'", created.body.runId);
    assert.equal(applied.length, 1, 'the run must emit exactly one experience_applied event');
    const appliedPayload = JSON.parse(applied[0].payload_json);
    assert.equal(appliedPayload.available, true);
    assert.ok(appliedPayload.sampleSize.runs >= 2);

    const routing = db.all("SELECT payload_json FROM run_events WHERE run_id=? AND type='routing_decision'", created.body.runId);
    const decision = routing.map((row) => JSON.parse(row.payload_json)).find((payload) => payload.taskType);
    assert.ok(decision, 'a routing decision must be recorded');
    assert.equal(decision.taskType, 'code', 'the goal is classified as code');
    assert.equal(decision.experienceApplied, true, 'the routing decision reflects the learned prior');
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- HTTP surface --------------------------------- */

test('GET /experience/summary returns the tenant-scoped learned scorecard over HTTP', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
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
    const email = `exp-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const registered = await request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: 'Exp HTTP' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const account = db.get('SELECT id, tenant_id FROM users WHERE email=?', email);

    // Seed two terminal code runs for THIS tenant (one clean, one failed tool).
    const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task');
    const t = new Date().toISOString();
    db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, account.tenant_id, account.id, 'Exp HTTP', t);
    db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, dir, t);
    db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, account.tenant_id, projectId, workspaceId, account.id, 'goal', 'completed', t, t);
    const okRun = id('run'); const badRun = id('run');
    db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', okRun, taskId, account.tenant_id, 'completed', '{}', 1, t, t);
    db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', badRun, taskId, account.tenant_id, 'failed', '{}', 1, t, t);
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), okRun, account.tenant_id, 'routing_decision', JSON.stringify({ taskType: 'code' }), t);
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), badRun, account.tenant_id, 'routing_decision', JSON.stringify({ taskType: 'code' }), t);
    seedUsage(db, { tenantId: account.tenant_id }, okRun, { model: 'claude-sonnet-4-6', provider: 'anthropic', createdAt: t });
    seedUsage(db, { tenantId: account.tenant_id }, badRun, { model: 'gpt-5', provider: 'openai', createdAt: t });

    const response = await request('/experience/summary', { token });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.available, true);
    assert.equal(response.body.sampleSize.runs, 2);
    assert.ok(response.body.models.code['claude-sonnet-4-6'], 'the winning code model is exposed');
    assert.equal(response.body.models.code['claude-sonnet-4-6'].successRate, 1);

    // Unauthenticated access is rejected.
    assert.equal((await request('/experience/summary')).status, 401);
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
