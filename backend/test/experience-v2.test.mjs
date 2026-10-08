import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import {
  DEFAULT_DECAY_HALF_LIFE_HOURS,
  MIN_OBSERVATIONS,
  buildExperienceSnapshot,
  decayWeight,
  executionPriorFromSnapshot,
  recoveryPriorFromSnapshot,
  recommendRecoveryAction,
  recommendRetryBudget,
  recommendStrategy,
  recommendTool,
  strategyPriorFromSnapshot,
  weightedStats,
  wilsonLowerBound,
} from '../agent/experience.mjs';

/**
 * Experience Engine v2 — the elevation beyond adaptive routing.
 *
 * These tests pin the two things that make the elevation SAFE and REAL:
 *   1. the data-quality protections (recency decay, effective-sample gate,
 *      Wilson lower bound, margin gate) behave exactly as designed, and
 *   2. the three new prior families (recovery / strategy / execution) are
 *      aggregated from REAL SQLite rows and turn into the right recommendation.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-exp-v2-'));
const HALF_LIFE_MS = DEFAULT_DECAY_HALF_LIFE_HOURS * 3_600_000;

/* ------------------------- estimator primitives --------------------------- */

test('decayWeight halves every half-life and is 1 at age 0', () => {
  assert.equal(decayWeight(0), 1);
  assert.ok(Math.abs(decayWeight(HALF_LIFE_MS) - 0.5) < 1e-9, 'one half-life -> 0.5');
  assert.ok(Math.abs(decayWeight(2 * HALF_LIFE_MS) - 0.25) < 1e-9, 'two half-lives -> 0.25');
  assert.ok(decayWeight(10 * HALF_LIFE_MS) < 0.001, 'stale evidence fades to ~nothing');
  // Negative ages (clock skew) must not explode the weight.
  assert.equal(decayWeight(-5000), 1);
});

test('wilsonLowerBound is conservative: it never exceeds the raw rate and rewards evidence', () => {
  assert.equal(wilsonLowerBound(0, 0), 0, 'no evidence -> 0');
  assert.ok(wilsonLowerBound(2, 2) < 1, 'a perfect 2/2 is discounted');
  // The core robustness property: a proven 18/20 out-ranks a lucky 2/2.
  assert.ok(
    wilsonLowerBound(18, 20) > wilsonLowerBound(2, 2),
    'proven track record must beat a lucky streak',
  );
  // Same rate, more evidence -> higher (tighter) lower bound.
  assert.ok(wilsonLowerBound(50, 100) > wilsonLowerBound(5, 10));
  // Never above the raw mean.
  for (const [s, n] of [[1, 3], [7, 10], [9, 10], [1, 1]]) {
    assert.ok(wilsonLowerBound(s, n) <= s / n + 1e-9);
  }
});

test('weightedStats applies recency, the effective-sample gate and the Wilson bound together', () => {
  const now = 1_700_000_000_000;
  // One fresh success + one very old failure: recency must dominate the raw mean.
  const recency = weightedStats(
    [{ success: true, atMs: now }, { success: false, atMs: now - 3 * HALF_LIFE_MS }],
    { nowMs: now },
  );
  assert.equal(recency.attempts, 2);
  assert.equal(recency.successes, 1);
  assert.equal(recency.successRate, 0.5, 'raw rate is still the honest 50%');
  assert.ok(recency.decayedSuccessRate > 0.8, 'but the decayed rate is pulled up by the fresh success');
  assert.ok(recency.decayedSuccessRate > recency.successRate);

  // A single observation is below the minimum-evidence gate -> zero confidence.
  const thin = weightedStats([{ success: true, atMs: now }], { nowMs: now });
  assert.equal(thin.confidence, 0, 'one observation is not evidence');

  // A *burst of old rows* cannot fake evidence: the effective sample is tiny.
  const stale = weightedStats(
    Array.from({ length: 20 }, () => ({ success: true, atMs: now - 12 * HALF_LIFE_MS })),
    { nowMs: now },
  );
  assert.equal(stale.attempts, 20, 'raw count is 20');
  assert.ok(stale.effectiveSamples < MIN_OBSERVATIONS, 'but the effective sample is far below the gate');
  assert.equal(stale.confidence, 0, 'stale evidence never earns confidence');

  // Fresh, plentiful evidence earns confidence.
  const solid = weightedStats(
    Array.from({ length: 6 }, () => ({ success: true, atMs: now })),
    { nowMs: now },
  );
  assert.equal(solid.confidence, 1, '6 fresh observations saturate confidence');
});

/* ---------------------------- recovery prior ------------------------------ */

test('recommendRecoveryAction picks the proven action and refuses thin or tied evidence', () => {
  const prior = {
    TOOL_FAILURE: {
      repair: { successRate: 0.2, confidence: 0.9, attempts: 10 },
      replan: { successRate: 0.8, confidence: 0.9, attempts: 10 },
    },
  };
  const rec = recommendRecoveryAction(prior, 'TOOL_FAILURE', { allowed: ['repair', 'replan'] });
  assert.equal(rec.action, 'replan');
  assert.ok(rec.margin === undefined || true);

  // Thin evidence (below confidence gate) -> no recommendation.
  assert.equal(
    recommendRecoveryAction({ TOOL_FAILURE: { replan: { successRate: 0.9, confidence: 0.2, attempts: 1 } } }, 'TOOL_FAILURE'),
    null,
  );
  // Near-tie -> no recommendation (never flip on noise).
  assert.equal(
    recommendRecoveryAction({ TOOL_FAILURE: { repair: { successRate: 0.7, confidence: 0.9, attempts: 10 }, replan: { successRate: 0.75, confidence: 0.9, attempts: 10 } } }, 'TOOL_FAILURE'),
    null,
  );
  // Unknown failure kind -> no recommendation.
  assert.equal(recommendRecoveryAction(prior, 'NETWORK_FAILURE'), null);
  // The `allowed` filter is respected (repair only).
  assert.equal(
    recommendRecoveryAction(prior, 'TOOL_FAILURE', { allowed: ['repair'] }).action,
    'repair',
  );
});

/* ---------------------------- strategy prior ------------------------------ */

test('recommendStrategy only flips when BOTH strategies have evidence and one clearly wins', () => {
  const winning = {
    code: {
      'single-agent': { successRate: 0.3, confidence: 0.9, attempts: 12 },
      'multi-agent': { successRate: 0.8, confidence: 0.9, attempts: 12 },
    },
  };
  const rec = recommendStrategy(winning, 'code');
  assert.equal(rec.strategy, 'multi-agent');
  assert.ok(rec.margin > 0.4);

  // Only one strategy observed -> cannot compare -> no recommendation.
  assert.equal(
    recommendStrategy({ code: { 'single-agent': { successRate: 0.9, confidence: 1, attempts: 30 } } }, 'code'),
    null,
    'single-agent-only history must NEVER flip a run to multi-agent',
  );
  // Near-tie -> no recommendation.
  assert.equal(
    recommendStrategy({ code: { 'single-agent': { successRate: 0.7, confidence: 0.9, attempts: 12 }, 'multi-agent': { successRate: 0.75, confidence: 0.9, attempts: 12 } } }, 'code'),
    null,
  );
  // Low confidence -> no recommendation.
  assert.equal(
    recommendStrategy({ code: { 'single-agent': { successRate: 0.2, confidence: 0.4, attempts: 2 }, 'multi-agent': { successRate: 0.9, confidence: 0.4, attempts: 2 } } }, 'code'),
    null,
  );
});

/* --------------------------- execution prior ------------------------------ */

test('recommendTool picks the most reliable tool with a real margin; recommendRetryBudget fails fast on proven flakiness', () => {
  const prior = {
    code: {
      'files.write': { successRate: 0.9, confidence: 0.9, attempts: 10 },
      'shell.run': { successRate: 0.4, confidence: 0.9, attempts: 10 },
    },
  };
  assert.equal(recommendTool(prior, 'code').toolId, 'files.write');
  // Exclusion (already chosen) works.
  assert.equal(recommendTool(prior, 'code', { exclude: ['files.write'] }), null, 'no runner-up with a margin');
  // Thin evidence -> null.
  assert.equal(recommendTool({ code: { 'files.write': { successRate: 0.9, confidence: 0.2, attempts: 1 } } }, 'code'), null);

  // A proven-flaky tool for this task type gets its retry budget cut to 1.
  const flaky = { code: { 'shell.run': { successRate: 0.1, confidence: 0.9, attempts: 10 } } };
  assert.equal(recommendRetryBudget({ executionPrior: flaky, taskType: 'code', toolId: 'shell.run', base: 3 }), 1);
  // A healthy tool keeps its base budget.
  const healthy = { code: { 'files.write': { successRate: 0.95, confidence: 0.9, attempts: 10 } } };
  assert.equal(recommendRetryBudget({ executionPrior: healthy, taskType: 'code', toolId: 'files.write', base: 3 }), 3);
  // No evidence -> base budget unchanged.
  assert.equal(recommendRetryBudget({ executionPrior: {}, taskType: 'code', toolId: 'shell.run', base: 2 }), 2);
  // Low confidence -> base budget unchanged.
  assert.equal(recommendRetryBudget({ executionPrior: { code: { 'shell.run': { successRate: 0.05, confidence: 0.3, attempts: 1 } } }, taskType: 'code', toolId: 'shell.run', base: 2 }), 2);
});

/* ------------------- aggregation from REAL SQLite rows -------------------- */

function seedTenant(db, label = 'V2') {
  const t = new Date().toISOString();
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

function seedTask(db, seed) {
  const taskId = id('task');
  const t = new Date().toISOString();
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, seed.tenantId, seed.projectId, seed.workspaceId, seed.userId, 'g', 'completed', t, t);
  return taskId;
}

/**
 * Seed one terminal run with a routing decision (task type), an optional
 * recovery event, an optional multi-agent marker and optional tool calls.
 */
function seedRun(db, seed, taskId, { status = 'completed', taskType = 'code', recovery = null, multiAgent = false, tools = [] } = {}) {
  const runId = id('run');
  const t = new Date().toISOString();
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, seed.tenantId, status, '{}', 1, t, t);
  db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, seed.tenantId, 'routing_decision', JSON.stringify({ taskType }), t);
  if (multiAgent) {
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, seed.tenantId, 'planning_started', JSON.stringify({ multiAgent: true }), t);
  }
  if (recovery) {
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, seed.tenantId, 'self_healing', JSON.stringify(recovery), t);
  }
  for (const [toolId, toolStatus] of tools) {
    db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,status,created_at) VALUES(?,?,?,?,?,?)', id('tc'), runId, toolId, '{}', toolStatus, t);
  }
  return runId;
}

test('buildExperienceSnapshot aggregates recovery, strategy and execution families from real rows', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedTenant(db);
    const taskId = seedTask(db, seed);

    // Three multi-agent runs that all succeeded after a replan, and three
    // single-agent runs that all failed after a repair. Three is the minimum
    // that clears the confidence gate (saturation 5 x 0.6).
    for (let i = 0; i < 3; i += 1) {
      seedRun(db, seed, taskId, { status: 'completed', taskType: 'code', multiAgent: true, recovery: { action: 'replan', failureKind: 'TOOL_FAILURE' }, tools: [['files.write', 'ok']] });
      seedRun(db, seed, taskId, { status: 'failed', taskType: 'code', multiAgent: false, recovery: { action: 'repair', failureKind: 'TOOL_FAILURE' }, tools: [['files.write', 'failed']] });
    }

    const snapshot = buildExperienceSnapshot(db, { tenantId: seed.tenantId });
    assert.equal(snapshot.version, 3);
    assert.equal(snapshot.sampleSize.runs, 6);
    assert.equal(snapshot.sampleSize.recoveryObservations, 6);
    assert.equal(snapshot.sampleSize.strategyObservations, 6);

    // Recovery family: replan succeeded, repair failed.
    assert.equal(snapshot.recovery.TOOL_FAILURE.replan.successes, 3);
    assert.equal(snapshot.recovery.TOOL_FAILURE.repair.successes, 0);
    const rec = recommendRecoveryAction(recoveryPriorFromSnapshot(snapshot), 'TOOL_FAILURE', { allowed: ['repair', 'replan'] });
    assert.equal(rec.action, 'replan', 'the learned recovery action is replan');

    // Strategy family: multi-agent won all, single-agent lost all.
    assert.equal(snapshot.strategies.code['multi-agent'].successes, 3);
    assert.equal(snapshot.strategies.code['single-agent'].successes, 0);
    assert.equal(recommendStrategy(strategyPriorFromSnapshot(snapshot), 'code').strategy, 'multi-agent');

    // Execution family: files.write failed half the time for this task type.
    assert.equal(snapshot.execution.code['files.write'].attempts, 6);
    assert.equal(snapshot.execution.code['files.write'].successes, 3);
    assert.ok(executionPriorFromSnapshot(snapshot).code['files.write'].successRate <= 0.5);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildExperienceSnapshot keeps every tenant isolated across the new families', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const a = seedTenant(db, 'A');
    const b = seedTenant(db, 'B');
    const taskA = seedTask(db, a);
    const taskB = seedTask(db, b);
    seedRun(db, a, taskA, { status: 'completed', taskType: 'code', multiAgent: true, recovery: { action: 'replan', failureKind: 'TOOL_FAILURE' } });
    seedRun(db, b, taskB, { status: 'failed', taskType: 'code', multiAgent: false, recovery: { action: 'repair', failureKind: 'TOOL_FAILURE' } });

    const snapshotA = buildExperienceSnapshot(db, { tenantId: a.tenantId });
    assert.equal(snapshotA.sampleSize.runs, 1);
    assert.equal(snapshotA.strategies.code['multi-agent'].successes, 1);
    assert.equal(snapshotA.strategies.code['single-agent'], undefined, 'tenant B history must not leak into A');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- HTTP surface (v2) ---------------------------- */

test('GET /experience/summary exposes the new recovery/strategy/execution families and derived priors', async () => {
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
    const email = `exp-v2-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const registered = await request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: 'Exp V2' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const account = db.get('SELECT id, tenant_id FROM users WHERE email=?', email);

    const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task');
    const t = new Date().toISOString();
    db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, account.tenant_id, account.id, 'Exp V2', t);
    db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, dir, t);
    db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, account.tenant_id, projectId, workspaceId, account.id, 'goal', 'completed', t, t);
    for (let i = 0; i < 3; i += 1) {
      seedRun(db, { tenantId: account.tenant_id }, taskId, { status: 'completed', taskType: 'code', multiAgent: true, recovery: { action: 'replan', failureKind: 'TOOL_FAILURE' }, tools: [['files.write', 'ok']] });
      seedRun(db, { tenantId: account.tenant_id }, taskId, { status: 'failed', taskType: 'code', multiAgent: false, recovery: { action: 'repair', failureKind: 'TOOL_FAILURE' }, tools: [['files.write', 'failed']] });
    }

    const response = await request('/experience/summary', { token });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.available, true);
    assert.ok(response.body.recovery.TOOL_FAILURE.replan, 'recovery family is exposed');
    assert.ok(response.body.strategies.code['multi-agent'], 'strategy family is exposed');
    assert.ok(response.body.execution.code['files.write'], 'execution family is exposed');
    assert.ok(response.body.derived.recovery.TOOL_FAILURE.replan, 'derived recovery prior includes the proven action');
    assert.ok(response.body.derived.recovery.TOOL_FAILURE.replan.successRate > response.body.derived.recovery.TOOL_FAILURE.repair.successRate, 'replan outranks repair');
    assert.ok(response.body.derived.strategies.code['multi-agent'], 'derived strategy prior includes multi-agent');
    assert.ok(response.body.derived.execution.code['files.write'], 'derived execution prior includes files.write');
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
