import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { MemoryStore } from '../memory/store.mjs';
import { evaluateRun } from '../agent/evaluation.mjs';
import { listReflections } from '../agent/reflection.mjs';
import {
  LEARNING_LOOP_VERSION,
  finalizeRunLearning,
  learningSummary,
  resetLearningLoopState,
  runLearningCycle,
} from '../agent/learning-loop.mjs';

/**
 * The UNIFIED learning loop (backend/agent/learning-loop.mjs).
 *
 * These tests prove the five components are actually wired into ONE loop and
 * that the loop records the CORRECT graded outcome:
 *
 *   EVALUATE -> REFLECT (persists quality + reward) -> CONSOLIDATE (memory) ->
 *   EXPERIENCE (graded score readable next snapshot) -> SELF-IMPROVE (bounded).
 *
 * The single most important test is the TIMING one: the runtime finalizes
 * learning BEFORE the queue persists the terminal run status, so the loop must
 * score the run from the AUTHORITATIVE result status, not the still-'running'
 * DB row. Without that fix every completed run would be scored as a 0.5.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-loop-'));

function seed(db, { runStatus = 'running' } = {}) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  const runId = id('run');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Loop Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'loop@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Loop Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'loop goal', runStatus === 'running' ? 'running' : runStatus, t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, runStatus, '{}', 1, t, t);
  const run = db.get('SELECT * FROM runs WHERE id=?', runId);
  return { tenantId, userId, projectId, workspaceId, taskId, runId, run };
}

const ev = (type, payload) => ({ type, payload_json: JSON.stringify(payload) });

test('TIMING FIX: the graded reward uses the authoritative result status, not the stale running row', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'loop.sqlite'));
  try {
    // The run row is STILL 'running' — exactly the state the runtime sees, because
    // the queue only persists the terminal status after the handler returns.
    const { tenantId, runId, run } = seed(db, { runStatus: 'running' });
    const events = [ev('tool_completed', { toolId: 'files.write', ok: true })];

    // Reading the stale row would mis-score a completed run as the neutral 0.5.
    const naive = evaluateRun(db, runId, { tenantId });
    assert.equal(naive.status, 'running');
    assert.equal(naive.outcome.successScore, 0.5, 'the stale row cannot distinguish a completed run');

    // The loop is told the real terminal status and scores it correctly.
    const learning = finalizeRunLearning({ db, run, result: { status: 'completed' }, events });
    assert.equal(learning.status, 'completed');
    assert.equal(learning.reward, 1, 'a completed run earns the full graded reward');
    assert.equal(learning.success, true);
    assert.equal(learning.qualityScore, 100, 'clean completion -> full composite quality');
    assert.ok(learning.reflectionId, 'a reflection was persisted');

    // The reflection is the durable join: it stores BOTH the graded score and reward.
    const reflections = listReflections(db, tenantId);
    assert.equal(reflections.length, 1);
    assert.equal(reflections[0].runId, runId);
    assert.equal(reflections[0].reward, 1);
    assert.equal(reflections[0].qualityScore, 100);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('finalizeRunLearning maps each terminal status to the right graded reward', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'loop.sqlite'));
  try {
    const cases = [
      ['completed', 1, 100],
      ['completed_with_warnings', 0.7, 85],
      ['failed', 0, 30],
    ];
    for (const [status, reward, quality] of cases) {
      const { run } = seed(db, { runStatus: 'running' });
      const learning = finalizeRunLearning({ db, run, result: { status }, events: [] });
      assert.equal(learning.status, status);
      assert.equal(learning.reward, reward, `reward for ${status}`);
      assert.equal(learning.qualityScore, quality, `quality for ${status}`);
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('finalizeRunLearning ignores a non-terminal (continuation) handoff', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'loop.sqlite'));
  try {
    const { tenantId, run } = seed(db, { runStatus: 'running' });
    // A long-running run that hands off returns status 'continuation': the run is
    // still outstanding, so the loop must NOT record a bogus reward for it.
    const learning = finalizeRunLearning({ db, run, result: { status: 'continuation' }, events: [] });
    assert.equal(learning, null);
    assert.equal(listReflections(db, tenantId).length, 0, 'no reflection for an outstanding run');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('finalizeRunLearning falls back to the persisted row when no status is supplied (backward compatible)', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'loop.sqlite'));
  try {
    const { run } = seed(db, { runStatus: 'completed' });
    const learning = finalizeRunLearning({ db, run, result: {}, events: [] });
    assert.equal(learning.status, 'completed');
    assert.equal(learning.reward, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('runLearningCycle closes EVALUATE -> REFLECT -> CONSOLIDATE -> SELF-IMPROVE in one call', async () => {
  resetLearningLoopState();
  const dir = await temp();
  const db = new Database(path.join(dir, 'loop.sqlite'));
  try {
    const memory = new MemoryStore(db);
    const { tenantId, projectId, run } = seed(db, { runStatus: 'running' });
    const events = [
      ev('tool_completed', { toolId: 'git.status', ok: false, error: 'not a repo' }),
      ev('run_finished', { note: 'AGENT_LOOP_DETECTED' }),
    ];

    const cycle = await runLearningCycle({
      db, memory, run, result: { status: 'completed_with_warnings' }, events, projectId,
      selfImprove: { enabled: true, intervalMs: 0 },
    });

    assert.equal(cycle.version, LEARNING_LOOP_VERSION);
    assert.equal(cycle.runId, run.id);
    assert.equal(cycle.status, 'completed_with_warnings');
    assert.equal(cycle.reward, 0.7, 'the graded reward flows through the whole cycle');
    assert.ok(cycle.lessons >= 2, 'lessons were distilled from the failure + loop events');
    // Memory stage ran and returned a real consolidation result.
    assert.ok(cycle.consolidated, 'consolidation ran');
    assert.equal(typeof cycle.consolidated.written, 'boolean');
    // Self-improve stage ran and is bounded (proposals only, no auto-apply).
    assert.ok(cycle.selfImprove, 'self-improve ran');
    assert.equal(typeof cycle.selfImprove.signals, 'number');
    assert.equal(typeof cycle.selfImprove.proposals, 'number');
    assert.equal(typeof cycle.selfImprove.rolledBack, 'number');

    // The reflection persisted by the cycle carries the graded score.
    const reflections = listReflections(db, tenantId, { projectId });
    assert.ok(reflections.some((r) => r.runId === run.id && r.reward === 0.7));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('runLearningCycle with finalize:false runs only the async remainder (no duplicate reflection)', async () => {
  resetLearningLoopState();
  const dir = await temp();
  const db = new Database(path.join(dir, 'loop.sqlite'));
  try {
    const memory = new MemoryStore(db);
    const { tenantId, run } = seed(db, { runStatus: 'running' });
    // The runtime finalizes synchronously first...
    finalizeRunLearning({ db, run, result: { status: 'completed' }, events: [] });
    const before = listReflections(db, tenantId).length;
    // ...then runs only the async remainder.
    const remainder = await runLearningCycle({ db, memory, run, result: { status: 'completed' }, events: [], finalize: false, selfImprove: { enabled: false } });
    assert.equal(remainder.runId, run.id);
    assert.equal(remainder.reward, undefined, 'no re-evaluation happened');
    assert.equal(listReflections(db, tenantId).length, before, 'no duplicate reflection was written');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('learningSummary surfaces all five components side by side', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'loop.sqlite'));
  try {
    const { tenantId, projectId, run } = seed(db, { runStatus: 'completed' });
    // Give the run a model so the experience snapshot has a cell.
    db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?)', id('usage'), run.id, tenantId, 'anthropic', 'claude-sonnet-4-6', 100, 0.4, now());
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), run.id, tenantId, 'routing_decision', JSON.stringify({ taskType: 'code' }), now());
    finalizeRunLearning({ db, run, result: { status: 'completed' }, events: [] });

    const summary = learningSummary({ db, tenantId, projectId });
    assert.equal(summary.available, true);
    assert.equal(summary.version, LEARNING_LOOP_VERSION);
    // EVALUATION
    assert.ok(summary.evaluation);
    assert.equal(summary.evaluation.count, 1);
    assert.equal(summary.evaluation.successRatio, 1);
    // EXPERIENCE
    assert.ok(summary.experience);
    assert.equal(summary.experience.rewardMode, 'graded');
    // SELF-IMPROVE
    assert.ok(summary.selfImprove);
    assert.equal(typeof summary.selfImprove.openProposals, 'number');
    // REFLECTION
    assert.ok(Array.isArray(summary.reflections));
    assert.equal(summary.reflections[0].reward, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('learningSummary is fail-soft and honest for an unknown tenant', () => {
  assert.deepEqual(learningSummary({ db: null, tenantId: 'x' }), { available: false });
  assert.deepEqual(learningSummary({}), { available: false });
});

test('GET /learning/summary exposes the whole loop for the authenticated tenant', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'loop.sqlite'));
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
    const email = `loop-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const registered = await request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: 'Loop HTTP' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const account = db.get('SELECT id, tenant_id FROM users WHERE email=?', email);

    const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task'); const runId = id('run');
    const t = now();
    db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, account.tenant_id, account.id, 'Loop HTTP', t);
    db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, dir, t);
    db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, account.tenant_id, projectId, workspaceId, account.id, 'goal', 'completed', t, t);
    db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, account.tenant_id, 'completed', '{}', 1, t, t);
    db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?)', id('usage'), runId, account.tenant_id, 'anthropic', 'claude-sonnet-4-6', 100, 0.4, t);
    db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, account.tenant_id, 'routing_decision', JSON.stringify({ taskType: 'code' }), t);
    finalizeRunLearning({ db, run: db.get('SELECT * FROM runs WHERE id=?', runId), result: { status: 'completed' }, events: [] });

    const response = await request('/learning/summary', { token });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.available, true);
    assert.equal(response.body.evaluation.count, 1);
    assert.equal(response.body.experience.rewardMode, 'graded');
    assert.equal(typeof response.body.selfImprove.openProposals, 'number');
    assert.equal(response.body.reflections[0].reward, 1);
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
