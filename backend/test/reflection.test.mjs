import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { REFLECTION_STATUSES, listReflections, loadLessons, reflectOnRun, summarizeRunOutcome } from '../agent/reflection.mjs';

/**
 * Cross-run reflection & episodic lessons. These tests prove the deterministic
 * lesson extraction is correct and that reflections are persisted in and read
 * back from real SQLite, so the NEXT run can be guided by what previous runs
 * learned.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-refl-'));

function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  const runId = id('run');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Refl Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'refl@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Refl Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'refl goal', 'completed', t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'completed', '{}', 1, t, t);
  return { tenantId, userId, projectId, workspaceId, taskId, runId };
}

const ev = (type, payload) => ({ type, payload_json: JSON.stringify(payload) });

test('summarizeRunOutcome distils lessons from tool failures, replans, loops and delivery', () => {
  const events = [
    ev('tool_completed', { toolId: 'git.status', ok: false, error: 'not a git repository' }),
    ev('tool_completed', { toolId: 'git.status', ok: false, error: 'still not a repo' }), // duplicate tool -> one lesson
    ev('self_healing', { action: 'replan' }),
    ev('self_healing', { action: 'replan' }),
    ev('run_finished', { note: 'AGENT_LOOP_DETECTED' }),
  ];
  const outcome = summarizeRunOutcome({ run: { status: 'completed_with_warnings' }, result: { status: 'completed_with_warnings' }, events });
  assert.equal(outcome.status, 'completed_with_warnings');
  assert.equal(outcome.lessons.length, 3, 'one lesson per distinct failure class');
  assert.ok(outcome.lessons.some((l) => /git\.status/.test(l) && /not a git repository/.test(l)));
  assert.ok(outcome.lessons.some((l) => /re-planning was needed 2 time/.test(l)));
  assert.ok(outcome.lessons.some((l) => /identical tool call was repeated/i.test(l)));
});

test('summarizeRunOutcome records delivery and unverified outcomes', () => {
  const delivered = summarizeRunOutcome({
    run: { status: 'completed' },
    result: { status: 'completed', delivery: { delivered: true, branch: 'agent/feature', changed: ['a.ts', 'b.ts'] } },
    events: [],
  });
  assert.equal(delivered.status, 'completed');
  assert.ok(delivered.lessons.some((l) => /delivered on branch "agent\/feature" \(2 file/.test(l)));
  assert.match(delivered.summary, /completed successfully and delivered/);

  const skipped = summarizeRunOutcome({
    run: { status: 'completed' },
    result: { status: 'completed', delivery: { delivered: false, reason: 'dirty_workspace' } },
    events: [],
  });
  assert.ok(skipped.lessons.some((l) => /Delivery was skipped \(dirty_workspace\)/.test(l)));

  const unverified = summarizeRunOutcome({ run: { status: 'unverified' }, result: { status: 'unverified' }, events: [] });
  assert.equal(unverified.status, 'unverified');
  assert.ok(unverified.lessons.some((l) => /could not be verified/.test(l)));
});

test('summarizeRunOutcome detects loop detection surfaced only through the result', () => {
  const outcome = summarizeRunOutcome({ run: { status: 'failed' }, result: { status: 'failed', error: 'AGENT_LOOP_DETECTED: git.status' }, events: [] });
  assert.ok(outcome.lessons.some((l) => /identical tool call was repeated/i.test(l)));
});

test('reflectOnRun persists a terminal reflection and returns it', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const s = seed(db);
    const run = db.get('SELECT * FROM runs WHERE id=?', s.runId);
    const reflection = reflectOnRun({
      db, run,
      result: { status: 'completed_with_warnings', delivery: { delivered: true, branch: 'agent/x', changed: ['f.ts'] } },
      events: [ev('tool_completed', { toolId: 'web.scrape', ok: false, error: 'timeout' })],
    });
    assert.ok(reflection && reflection.id);
    assert.equal(reflection.projectId, s.projectId);
    assert.equal(reflection.runId, s.runId);

    const stored = db.get('SELECT * FROM agent_reflections WHERE id=?', reflection.id);
    assert.equal(stored.status, 'completed_with_warnings');
    assert.ok(JSON.parse(stored.lessons_json).length >= 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('reflectOnRun ignores non-terminal runs', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const s = seed(db);
    const run = { ...db.get('SELECT * FROM runs WHERE id=?', s.runId), status: 'running' };
    assert.equal(reflectOnRun({ db, run, result: { status: 'running' }, events: [] }), null);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM agent_reflections').n, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadLessons returns the most recent, de-duplicated lessons for a project', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const s = seed(db);
    const run = db.get('SELECT * FROM runs WHERE id=?', s.runId);
    // Two reflections whose lesson sets overlap.
    reflectOnRun({ db, run, result: { status: 'completed' }, events: [ev('tool_completed', { toolId: 'git.status', ok: false, error: 'x' })] });
    await new Promise((r) => setTimeout(r, 5));
    reflectOnRun({ db, run, result: { status: 'completed' }, events: [ev('tool_completed', { toolId: 'git.status', ok: false, error: 'x' }), ev('self_healing', { action: 'replan' })] });

    const lessons = loadLessons(db, { tenantId: s.tenantId, projectId: s.projectId, limit: 10 });
    const unique = new Set(lessons);
    assert.equal(unique.size, lessons.length, 'lessons must be de-duplicated');
    assert.ok(lessons.some((l) => /git\.status/.test(l)));
    assert.ok(lessons.some((l) => /re-planning/.test(l)));

    // limit is honoured.
    assert.equal(loadLessons(db, { tenantId: s.tenantId, projectId: s.projectId, limit: 1 }).length, 1);
    // Unknown tenant -> empty, no throw.
    assert.deepEqual(loadLessons(db, { tenantId: 'nope' }), []);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('listReflections returns newest-first structured reflections', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const s = seed(db);
    const run = db.get('SELECT * FROM runs WHERE id=?', s.runId);
    reflectOnRun({ db, run, result: { status: 'completed' }, events: [] });
    await new Promise((r) => setTimeout(r, 5));
    reflectOnRun({ db, run, result: { status: 'failed', error: 'AGENT_LOOP_DETECTED' }, events: [] });
    const list = listReflections(db, s.tenantId, { projectId: s.projectId });
    assert.equal(list.length, 2);
    assert.equal(list[0].status, 'failed', 'newest first');
    assert.ok(Array.isArray(list[0].lessons));
    assert.ok(REFLECTION_STATUSES.includes(list[0].status));
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
