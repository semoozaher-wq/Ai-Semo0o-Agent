import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { RunQueue } from '../queue/queue.mjs';
import {
  TRIGGER_KINDS,
  TriggerScheduler,
  computeNextRun,
  normalizeSchedule,
  parseCron,
  parseInterval,
} from '../queue/scheduler.mjs';

/**
 * Trigger Scheduler. These tests prove real, dependency-free schedule maths and
 * that a due trigger actually creates a task and enqueues a run through the SAME
 * RunQueue the rest of the platform uses (idempotent per fire time), against a
 * real SQLite database.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-sched-'));

function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Sched Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'sched@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Sched Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  return { tenantId, userId, projectId, workspaceId };
}

function insertTrigger(db, seedData, overrides = {}) {
  const trigger = {
    id: id('trigger'), tenant_id: seedData.tenantId, project_id: seedData.projectId,
    workspace_id: seedData.workspaceId, created_by: seedData.userId,
    name: 'test trigger', kind: 'interval', schedule: '15m', goal: 'scheduled goal',
    payload_json: '{}', enabled: 1, next_run_at: new Date(Date.now() - 60_000).toISOString(),
    run_count: 0, created_at: now(), updated_at: now(), ...overrides,
  };
  db.run(
    'INSERT INTO scheduled_triggers(id,tenant_id,project_id,workspace_id,created_by,name,kind,schedule,goal,payload_json,enabled,next_run_at,run_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    trigger.id, trigger.tenant_id, trigger.project_id, trigger.workspace_id, trigger.created_by,
    trigger.name, trigger.kind, trigger.schedule, trigger.goal, trigger.payload_json, trigger.enabled,
    trigger.next_run_at, trigger.run_count, trigger.created_at, trigger.updated_at,
  );
  return trigger;
}

test('parseCron expands wildcards, ranges, steps and comma lists (and folds dow 7 -> 0)', () => {
  const every = parseCron('* * * * *');
  assert.equal(every.minute.size, 60);
  assert.equal(every.hour.size, 24);
  assert.equal(every.domStar, true);
  assert.equal(every.dowStar, true);

  const workday = parseCron('0 9 * * 1-5');
  assert.deepEqual([...workday.hour], [9]);
  assert.deepEqual([...workday.dow].sort(), [1, 2, 3, 4, 5]);

  const stepped = parseCron('*/15 * * * *');
  assert.deepEqual([...stepped.minute].sort((a, b) => a - b), [0, 15, 30, 45]);

  const list = parseCron('0 0 * * 0,6');
  assert.deepEqual([...list.dow].sort(), [0, 6]);

  const sundayAlias = parseCron('0 0 * * 7');
  assert.deepEqual([...sundayAlias.dow], [0]);
});

test('parseCron rejects malformed expressions', () => {
  assert.throws(() => parseCron('0 0 * *'), /CRON_FIELD_COUNT_INVALID/);
  assert.throws(() => parseCron('0 0 * * 8'), /CRON_FIELD_OUT_OF_RANGE/);
  assert.throws(() => parseCron('99 * * * *'), /CRON_FIELD_OUT_OF_RANGE/);
  assert.throws(() => parseCron('*/0 * * * *'), /CRON_STEP_INVALID/);
});

test('parseInterval converts s/m/h/d units and rejects junk', () => {
  assert.equal(parseInterval('30s'), 30_000);
  assert.equal(parseInterval('15m'), 900_000);
  assert.equal(parseInterval('2h'), 7_200_000);
  assert.equal(parseInterval('1d'), 86_400_000);
  assert.equal(parseInterval(' 5 m '), 300_000);
  assert.throws(() => parseInterval('15'), /INTERVAL_INVALID/);
  assert.throws(() => parseInterval('0m'), /INTERVAL_INVALID/);
  assert.throws(() => parseInterval('abc'), /INTERVAL_INVALID/);
});

test('normalizeSchedule validates per kind', () => {
  assert.deepEqual(TRIGGER_KINDS, ['cron', 'interval', 'once']);
  assert.equal(normalizeSchedule('interval', '15m'), '15m');
  assert.equal(normalizeSchedule('cron', '0 9 * * 1'), '0 9 * * 1');
  assert.equal(normalizeSchedule('once', '2026-06-01T12:00:00Z'), '2026-06-01T12:00:00.000Z');
  assert.throws(() => normalizeSchedule('interval', 'nope'), /INTERVAL_INVALID/);
  assert.throws(() => normalizeSchedule('cron', 'bad'), /CRON_FIELD_COUNT_INVALID/);
  assert.throws(() => normalizeSchedule('once', 'not-a-date'), /SCHEDULE_ONCE_INVALID/);
  assert.throws(() => normalizeSchedule('weekly', 'x'), /TRIGGER_KIND_INVALID/);
});

test('computeNextRun: once, interval (anchored) and cron', () => {
  const from = new Date('2026-01-01T00:00:00Z'); // Thursday
  // once: future fires, past does not.
  assert.equal(computeNextRun({ kind: 'once', schedule: '2026-06-01T12:00:00Z' }, from).toISOString(), '2026-06-01T12:00:00.000Z');
  assert.equal(computeNextRun({ kind: 'once', schedule: '2020-01-01T00:00:00Z' }, from), null);
  // interval: anchored at created_at, strictly after `from`.
  const iv = { kind: 'interval', schedule: '15m', created_at: '2026-01-01T00:00:00Z' };
  assert.equal(computeNextRun(iv, new Date('2026-01-01T00:10:00Z')).toISOString(), '2026-01-01T00:15:00.000Z');
  assert.equal(computeNextRun(iv, new Date('2026-01-01T00:15:00Z')).toISOString(), '2026-01-01T00:30:00.000Z');
  // cron: next Monday 09:00 after Thu 2026-01-01.
  assert.equal(computeNextRun({ kind: 'cron', schedule: '0 9 * * 1' }, from).toISOString(), '2026-01-05T09:00:00.000Z');
  // cron: daily midnight.
  assert.equal(computeNextRun({ kind: 'cron', schedule: '0 0 * * *' }, from).toISOString(), '2026-01-02T00:00:00.000Z');
  // cron: every 15 minutes.
  assert.equal(computeNextRun({ kind: 'cron', schedule: '*/15 * * * *' }, new Date('2026-01-01T00:07:00Z')).toISOString(), '2026-01-01T00:15:00.000Z');
});

test('a due trigger fires exactly once: creates a task and enqueues an idempotent run', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    // created_at anchors the interval, so put it in the past: one fire must then
    // advance next_run_at to a genuinely future moment (created_at + 15m).
    const trigger = insertTrigger(db, seedData, {
      kind: 'interval', schedule: '15m',
      created_at: new Date(Date.now() - 300_000).toISOString(),
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const queue = new RunQueue(db, { pollMs: 10 });
    let handled = 0;
    queue.register('agent.run', async () => { handled += 1; return { status: 'completed' }; });
    const scheduler = new TriggerScheduler(db, { queue, pollMs: 10 });

    const tasksBefore = db.get('SELECT COUNT(*) AS n FROM tasks').n;
    const first = await scheduler.tick();
    assert.equal(first.fired, 1);
    assert.deepEqual(first.ids, [trigger.id]);

    const tasksAfter = db.get('SELECT COUNT(*) AS n FROM tasks').n;
    assert.equal(tasksAfter, tasksBefore + 1, 'a task must be created for the scheduled run');

    const runs = db.all('SELECT * FROM runs WHERE tenant_id=?', seedData.tenantId);
    assert.equal(runs.length, 1, 'exactly one run must be enqueued');
    const payload = JSON.parse(runs[0].payload_json);
    assert.equal(payload.goal, 'scheduled goal');
    assert.equal(payload.triggerId, trigger.id);
    assert.equal(payload.kind, 'agent.run');

    const updated = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    assert.equal(updated.run_count, 1);
    assert.ok(updated.next_run_at > trigger.next_run_at, 'next_run_at must advance into the future');
    assert.equal(updated.last_error, null);

    // A second tick immediately after must NOT double-fire (next_run_at advanced).
    const second = await scheduler.tick();
    assert.equal(second.fired, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM runs WHERE tenant_id=?', seedData.tenantId).n, 1);

    // The queued run is processed by the ordinary queue/worker path.
    await queue.tick();
    assert.equal(handled, 1);
    assert.equal(db.get('SELECT status FROM runs WHERE id=?', runs[0].id).status, 'completed');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('firing is idempotent per fire time even if the same trigger snapshot is fired twice', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const trigger = insertTrigger(db, seedData, { kind: 'interval', schedule: '1h' });
    const queue = new RunQueue(db, { pollMs: 10 });
    const scheduler = new TriggerScheduler(db, { queue, pollMs: 10 });

    const snapshot = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    scheduler.fire(snapshot);
    scheduler.fire(snapshot); // same fire time -> same idempotency key

    assert.equal(db.get('SELECT COUNT(*) AS n FROM runs WHERE tenant_id=?', seedData.tenantId).n, 1, 'idempotency key must collapse duplicate fires');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a disabled trigger never fires', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    insertTrigger(db, seedData, { enabled: 0 });
    const queue = new RunQueue(db, { pollMs: 10 });
    const scheduler = new TriggerScheduler(db, { queue, pollMs: 10 });
    assert.equal((await scheduler.tick()).fired, 0);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM runs WHERE tenant_id=?', seedData.tenantId).n, 0);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordError stores the failure and advances the schedule without wedging', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const trigger = insertTrigger(db, seedData, { kind: 'interval', schedule: '1h' });
    const queue = new RunQueue(db, { pollMs: 10 });
    const scheduler = new TriggerScheduler(db, { queue, pollMs: 10 });
    const snapshot = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    scheduler.recordError(snapshot, new Error('boom'));
    const updated = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    assert.equal(updated.last_error, 'boom');
    assert.ok(updated.next_run_at > snapshot.next_run_at);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('start()/stop() are side-effect free until started and safe to call twice', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    insertTrigger(db, seedData, { kind: 'interval', schedule: '1h' });
    const queue = new RunQueue(db, { pollMs: 10 });
    const scheduler = new TriggerScheduler(db, { queue, pollMs: 60_000 });
    // Constructing the scheduler must not have fired anything.
    assert.equal(db.get('SELECT COUNT(*) AS n FROM runs WHERE tenant_id=?', seedData.tenantId).n, 0);
    scheduler.start();
    scheduler.start(); // idempotent
    await new Promise((resolve) => setTimeout(resolve, 50));
    scheduler.stop();
    scheduler.stop(); // idempotent
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
