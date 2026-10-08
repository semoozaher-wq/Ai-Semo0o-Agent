import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id } from '../db/client.mjs';
import { OUTCOME_SCORES } from '../agent/evaluation.mjs';
import {
  DEFAULT_REWARD_MODE,
  EXPERIENCE_VERSION,
  REWARD_MODES,
  buildExperienceSnapshot,
  gradedReward,
  modelPriorFromSnapshot,
  summarizeExperience,
  weightedStats,
} from '../agent/experience.mjs';

/**
 * Experience Engine v3 — GRADED reward.
 *
 * v2 learned from a BINARY success signal (did the run "succeed"?) while the
 * evaluation layer already produced a GRADED outcome (completed=1.0,
 * completed_with_warnings=0.7, unverified=0.5, blocked=0.2, cancelled=0.1,
 * failed=0.0). v3 makes the Experience Engine consume that SAME graded scale, so
 * a partially-successful run moves the estimate by exactly the fraction it
 * earned instead of being collapsed to a coin-flip.
 *
 * These tests pin three things:
 *   1. the graded mapping is EXACTLY evaluation's OUTCOME_SCORES (one definition);
 *   2. the graded signal flows through the shared estimator and the real SQLite
 *      aggregation into the model prior;
 *   3. it is fully BACKWARD COMPATIBLE — `rewardMode: 'binary'` reproduces v2
 *      byte-for-byte, and an observation without a `reward` is treated as binary.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-exp-v3-'));

/* ------------------------------ gradedReward ------------------------------ */

test('gradedReward maps every terminal status to evaluation\'s OUTCOME_SCORES', () => {
  for (const [status, score] of Object.entries(OUTCOME_SCORES)) {
    assert.equal(gradedReward(status), score, `gradedReward(${status}) must equal OUTCOME_SCORES`);
  }
  // An unknown / non-terminal status is the neutral 0.5 evaluation also uses.
  assert.equal(gradedReward('running'), 0.5);
  assert.equal(gradedReward(undefined), 0.5);
});

test('gradedReward in binary mode collapses to 0/1 and treats warnings as success', () => {
  assert.equal(gradedReward('completed', 'binary'), 1);
  assert.equal(gradedReward('completed_with_warnings', 'binary'), 1);
  assert.equal(gradedReward('unverified', 'binary'), 0);
  assert.equal(gradedReward('blocked', 'binary'), 0);
  assert.equal(gradedReward('failed', 'binary'), 0);
  // The default mode is one of the two declared modes.
  assert.ok(REWARD_MODES.includes(DEFAULT_REWARD_MODE));
  assert.equal(EXPERIENCE_VERSION, 3);
});

/* --------------------- estimator: graded vs binary mass ------------------- */

test('weightedStats computes the Wilson bound over the FRACTIONAL (graded) mass', () => {
  const now = 1_700_000_000_000;
  const obs = [
    { success: true, reward: 1, atMs: now },   // completed
    { success: true, reward: 0.7, atMs: now }, // completed_with_warnings
    { success: false, reward: 0, atMs: now },  // failed
  ];
  const graded = weightedStats(obs, { nowMs: now });
  assert.equal(graded.attempts, 3);
  assert.equal(graded.successes, 2, 'raw successes still count completed + warnings');
  assert.equal(graded.meanReward, 0.5667, 'mean graded reward = (1 + 0.7 + 0)/3');
  assert.ok(graded.decayedReward < graded.decayedSuccessRate, 'graded mass is below the binary rate here');
  assert.equal(graded.rewardMode, 'graded');

  // Binary mode ignores the reward and reproduces the v2 behaviour exactly.
  const binary = weightedStats(obs, { nowMs: now, rewardMode: 'binary' });
  assert.equal(binary.meanReward, 0.6667, 'binary counts 2/3 as full successes');
  assert.equal(binary.decayedReward, binary.decayedSuccessRate, 'binary: graded == binary rate');
});

test('an observation without a reward field is treated as binary (backward compatible)', () => {
  const now = 1_700_000_000_000;
  const legacy = [{ success: true, atMs: now }, { success: false, atMs: now }];
  const stats = weightedStats(legacy, { nowMs: now });
  assert.equal(stats.meanReward, 0.5, 'no reward -> success collapses to 1/0');
  assert.equal(stats.decayedReward, stats.decayedSuccessRate);
});

/* ------------------- aggregation from REAL SQLite rows -------------------- */

function seedTenant(db, label = 'V3') {
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

function seedModelRun(db, seed, taskId, { status, taskType = 'code', model = 'claude-sonnet-4-6' }) {
  const runId = id('run');
  const t = new Date().toISOString();
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, seed.tenantId, status, '{}', 1, t, t);
  db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, seed.tenantId, 'routing_decision', JSON.stringify({ taskType }), t);
  db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('usage'), runId, seed.tenantId, 'anthropic', model, 0, 0, 100, 0.4, t);
  return runId;
}

test('buildExperienceSnapshot aggregates a GRADED reward from real rows (not a coin-flip)', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedTenant(db);
    const taskId = seedTask(db, seed);
    // Same model, six terminal runs: 2 clean, 2 warnings, 1 unverified, 1 failed.
    seedModelRun(db, seed, taskId, { status: 'completed' });
    seedModelRun(db, seed, taskId, { status: 'completed' });
    seedModelRun(db, seed, taskId, { status: 'completed_with_warnings' });
    seedModelRun(db, seed, taskId, { status: 'completed_with_warnings' });
    seedModelRun(db, seed, taskId, { status: 'unverified' });
    seedModelRun(db, seed, taskId, { status: 'failed' });

    const graded = buildExperienceSnapshot(db, { tenantId: seed.tenantId });
    assert.equal(graded.version, 3);
    assert.equal(graded.rewardMode, 'graded');
    const cell = graded.models.code['claude-sonnet-4-6'];
    assert.equal(cell.attempts, 6);
    assert.equal(cell.successes, 4, 'completed + warnings count as binary successes');
    // Graded mean = (1 + 1 + 0.7 + 0.7 + 0.5 + 0)/6 = 3.9/6 = 0.65.
    assert.equal(cell.meanReward, 0.65);
    assert.ok(cell.decayedReward < cell.decayedSuccessRate, 'graded reward is strictly below the binary rate');

    // The model prior exposes the graded reward, and it matches the cell.
    const prior = modelPriorFromSnapshot(graded);
    assert.equal(prior.code['claude-sonnet-4-6'].reward, cell.decayedReward);

    // summarizeExperience surfaces the mode + a single avg reward number.
    const summary = summarizeExperience(graded);
    assert.equal(summary.rewardMode, 'graded');
    assert.equal(summary.avgReward, cell.decayedReward);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewardMode: binary reproduces the v2 aggregation exactly (no-regression)', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seed = seedTenant(db, 'V3B');
    const taskId = seedTask(db, seed);
    seedModelRun(db, seed, taskId, { status: 'completed' });
    seedModelRun(db, seed, taskId, { status: 'completed_with_warnings' });
    seedModelRun(db, seed, taskId, { status: 'failed' });

    const binary = buildExperienceSnapshot(db, { tenantId: seed.tenantId, rewardMode: 'binary' });
    assert.equal(binary.rewardMode, 'binary');
    const cell = binary.models.code['claude-sonnet-4-6'];
    assert.equal(cell.meanReward, 0.6667, 'binary: 2 of 3 succeed');
    assert.equal(cell.decayedReward, cell.decayedSuccessRate, 'binary: graded == binary rate');
    assert.equal(summarizeExperience(binary).rewardMode, 'binary');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
