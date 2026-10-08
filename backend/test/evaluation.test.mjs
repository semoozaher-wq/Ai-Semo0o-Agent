import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { compareRuns, composeQualityScore, evaluateRun, evaluateRuns } from '../agent/evaluation.mjs';

/**
 * Evaluation & quality-control layer. The composite score is pure and tested
 * directly; the per-run / aggregate / comparison functions are exercised against
 * REAL SQLite rows so the numbers are reproducible.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-eval-'));

function seedTenant(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Eval Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'eval@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Eval Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  return { tenantId, userId, projectId, workspaceId };
}

function seedTask(db, seedData, goal = 'g') {
  const taskId = id('task');
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, seedData.tenantId, seedData.projectId, seedData.workspaceId, seedData.userId, goal, 'completed', now(), now());
  return taskId;
}

function seedRun(db, seedData, taskId, { status = 'completed', createdAt = '2024-01-01T00:00:00.000Z', updatedAt = '2024-01-01T00:00:05.000Z' } = {}) {
  const runId = id('run');
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, seedData.tenantId, status, JSON.stringify({ kind: 'code.run' }), 1, createdAt, updatedAt);
  return runId;
}

/* ------------------------------ composite score --------------------------- */

test('composeQualityScore returns 100 for a clean, autonomous, verified run', () => {
  assert.equal(composeQualityScore({ successScore: 1, evidenceCompleteness: 1, toolSuccessRatio: 1 }), 100);
});

test('composeQualityScore penalises failed tools, intervention, replans and loops', () => {
  assert.equal(composeQualityScore({ successScore: 0, evidenceCompleteness: 0, toolSuccessRatio: 0 }), 15, 'a failed run keeps only the discipline+autonomy floor minus tools');
  assert.equal(composeQualityScore({ successScore: 1, evidenceCompleteness: 1, toolSuccessRatio: 1, interventionRequired: true }), 90, 'human intervention removes the autonomy weight');
  assert.equal(composeQualityScore({ successScore: 1, evidenceCompleteness: 1, toolSuccessRatio: 1, replans: 2 }), 95, 'two replans exhaust the discipline weight');
  assert.equal(composeQualityScore({ successScore: 1, evidenceCompleteness: 1, toolSuccessRatio: 1, loopDetected: true }), 95, 'a detected loop exhausts the discipline weight');
});

/* ------------------------------- single run ------------------------------- */

test('evaluateRun returns null for an unknown run', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try { assert.equal(evaluateRun(db, 'run_missing'), null); } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluateRun scores a completed run from its durable rows', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seedTenant(db);
    const taskId = seedTask(db, seedData);
    const runId = seedRun(db, seedData, taskId, { status: 'completed' });
    db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?)', id('usage'), runId, seedData.tenantId, 'openai', 'gpt', 100, 0.5, now());

    const evaluation = evaluateRun(db, runId, { tenantId: seedData.tenantId });
    assert.equal(evaluation.status, 'completed');
    assert.equal(evaluation.success, true);
    assert.equal(evaluation.outcome.successScore, 1);
    assert.equal(evaluation.cost.tokens, 100);
    assert.equal(evaluation.cost.costUsd, 0.5);
    assert.equal(evaluation.cost.latencyMs, 5_000);
    assert.equal(evaluation.qualityScore, 100, 'a clean completed run scores 100');
    assert.equal(evaluation.humanIntervention.required, false);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluateRun reflects failed tool calls, verification evidence and approvals', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seedTenant(db);
    const taskId = seedTask(db, seedData);
    const runId = seedRun(db, seedData, taskId, { status: 'completed' });
    db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,status,created_at) VALUES(?,?,?,?,?,?)', id('tc'), runId, 'files.write', '{}', 'failed', now());
    db.run('INSERT INTO evidence(id,run_id,kind,payload_json,sha256,created_at) VALUES(?,?,?,?,?,?)', id('ev'), runId, 'verification', JSON.stringify({ status: 'VERIFIED' }), 'h', now());
    db.run('INSERT INTO evidence(id,run_id,kind,payload_json,sha256,created_at) VALUES(?,?,?,?,?,?)', id('ev'), runId, 'verification', JSON.stringify({ status: 'UNVERIFIED' }), 'h', now());
    db.run('INSERT INTO approvals(id,run_id,requested_by,capability,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)', id('appr'), runId, seedData.userId, 'git.push', 'pending', 'needs review', now());
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, seedData.tenantId, 'self_healing', JSON.stringify({ action: 'replan' }), now());

    const evaluation = evaluateRun(db, runId);
    assert.equal(evaluation.toolUse.totalCalls, 1);
    assert.equal(evaluation.toolUse.failedCalls, 1);
    assert.equal(evaluation.toolUse.successRatio, 0);
    assert.equal(evaluation.toolUse.replans, 1);
    assert.equal(evaluation.verification.verifiedSteps, 1);
    assert.equal(evaluation.verification.unverifiedSteps, 1);
    assert.equal(evaluation.verification.completeness, 0.5);
    assert.equal(evaluation.humanIntervention.approvalsRequested, 1);
    assert.equal(evaluation.humanIntervention.approvalsPending, 1);
    assert.equal(evaluation.humanIntervention.required, true);
    // success 50 + evidence 10 + tools 0 + autonomy 0 + discipline (5 - 2.5) = 62.5
    assert.equal(evaluation.qualityScore, 62.5);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluateRun marks a failed run as unsuccessful with a zero outcome score', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seedTenant(db);
    const taskId = seedTask(db, seedData);
    const runId = seedRun(db, seedData, taskId, { status: 'failed' });
    const evaluation = evaluateRun(db, runId, { tenantId: seedData.tenantId });
    assert.equal(evaluation.success, false);
    assert.equal(evaluation.outcome.successScore, 0);
    assert.equal(evaluation.cost.costPerSuccess, null);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluateRun enforces tenant isolation', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seedTenant(db);
    const taskId = seedTask(db, seedData);
    const runId = seedRun(db, seedData, taskId);
    assert.equal(evaluateRun(db, runId, { tenantId: 'tenant_other' }), null);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------- aggregate -------------------------------- */

test('evaluateRuns aggregates a windowed scorecard', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seedTenant(db);
    const taskId = seedTask(db, seedData);
    const okRun = seedRun(db, seedData, taskId, { status: 'completed' });
    const badRun = seedRun(db, seedData, taskId, { status: 'failed' });
    db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?)', id('usage'), okRun, seedData.tenantId, 'openai', 'gpt', 10, 0.2, now());
    db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?)', id('usage'), badRun, seedData.tenantId, 'openai', 'gpt', 10, 0.3, now());

    const summary = evaluateRuns(db, { tenantId: seedData.tenantId, now: () => new Date('2024-01-02T00:00:00.000Z') });
    assert.equal(summary.count, 2);
    assert.equal(summary.byStatus.completed, 1);
    assert.equal(summary.byStatus.failed, 1);
    assert.equal(summary.successRatio, 0.5);
    assert.equal(summary.totalCostUsd, 0.5);
    assert.equal(summary.costPerSuccess, 0.5);
    assert.equal(summary.avgLatencyMs, 5_000);
    assert.equal(summary.runs.length, 2);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------------- comparison ------------------------------- */

test('compareRuns flags a quality regression beyond the threshold', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seedTenant(db);
    const taskId = seedTask(db, seedData);
    const baseline = seedRun(db, seedData, taskId, { status: 'completed' });
    const candidate = seedRun(db, seedData, taskId, { status: 'failed' });
    const comparison = compareRuns(db, baseline, candidate, { tenantId: seedData.tenantId, threshold: 5 });
    assert.ok(comparison);
    assert.equal(comparison.regression, true, 'a drop from 100 to ~30 is a regression');
    assert.equal(comparison.improved, false);
    assert.ok(comparison.deltas.qualityScore < 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('compareRuns returns null when either run is missing', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seedTenant(db);
    const taskId = seedTask(db, seedData);
    const runId = seedRun(db, seedData, taskId);
    assert.equal(compareRuns(db, runId, 'run_missing', { tenantId: seedData.tenantId }), null);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
