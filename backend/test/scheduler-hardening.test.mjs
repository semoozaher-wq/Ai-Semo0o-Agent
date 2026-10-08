import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { RunQueue } from '../queue/queue.mjs';
import {
  MISSED_RUN_POLICIES,
  TriggerScheduler,
  computeNextRun,
  isValidTimeZone,
  nextCronTime,
  nextCronTimeInZone,
  parseCron,
} from '../queue/scheduler.mjs';

/**
 * Scheduler hardening: timezone/DST-aware cron, missed-run policies, bounded
 * retry/backoff and a concurrency cap. These exercise the real module against a
 * real SQLite database and the real RunQueue — no mocks of the scheduling maths.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-schedh-'));

function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'SchedH Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'schedh@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'SchedH Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  return { tenantId, userId, projectId, workspaceId };
}

function insertTrigger(db, seedData, overrides = {}) {
  const trigger = {
    id: id('trigger'), tenant_id: seedData.tenantId, project_id: seedData.projectId,
    workspace_id: seedData.workspaceId, created_by: seedData.userId,
    name: 'hardened trigger', kind: 'cron', schedule: '0 * * * *', goal: 'scheduled goal',
    payload_json: '{}', enabled: 1, next_run_at: new Date(Date.now() - 60_000).toISOString(),
    timezone: 'UTC', missed_run_policy: 'catchup', retry_count: 0, max_retries: 3,
    run_count: 0, created_at: now(), updated_at: now(), ...overrides,
  };
  db.run(
    'INSERT INTO scheduled_triggers(id,tenant_id,project_id,workspace_id,created_by,name,kind,schedule,goal,payload_json,enabled,next_run_at,timezone,missed_run_policy,retry_count,max_retries,run_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    trigger.id, trigger.tenant_id, trigger.project_id, trigger.workspace_id, trigger.created_by,
    trigger.name, trigger.kind, trigger.schedule, trigger.goal, trigger.payload_json, trigger.enabled,
    trigger.next_run_at, trigger.timezone, trigger.missed_run_policy, trigger.retry_count, trigger.max_retries,
    trigger.run_count, trigger.created_at, trigger.updated_at,
  );
  return trigger;
}

test('isValidTimeZone accepts IANA zones and rejects nonsense', () => {
  assert.equal(isValidTimeZone('UTC'), true);
  assert.equal(isValidTimeZone(''), true); // treated as UTC
  assert.equal(isValidTimeZone('America/New_York'), true);
  assert.equal(isValidTimeZone('Asia/Riyadh'), true);
  assert.equal(isValidTimeZone('Europe/London'), true);
  assert.equal(isValidTimeZone('Mars/Phobos'), false);
  assert.equal(isValidTimeZone('Not/AZone'), false);
});

test('nextCronTimeInZone evaluates wall-clock cron in the zone and tracks DST', () => {
  const nine = parseCron('0 9 * * *');
  // 09:00 New York: EST (UTC-5) before spring-forward, EDT (UTC-4) after.
  assert.equal(nextCronTimeInZone(nine, new Date('2026-03-07T00:00:00Z'), 'America/New_York').toISOString(), '2026-03-07T14:00:00.000Z');
  assert.equal(nextCronTimeInZone(nine, new Date('2026-03-08T00:00:00Z'), 'America/New_York').toISOString(), '2026-03-08T13:00:00.000Z');
  // Fall-back: EDT (UTC-4) on Oct 31, EST (UTC-5) on Nov 1.
  assert.equal(nextCronTimeInZone(nine, new Date('2026-10-31T00:00:00Z'), 'America/New_York').toISOString(), '2026-10-31T13:00:00.000Z');
  assert.equal(nextCronTimeInZone(nine, new Date('2026-11-01T00:00:00Z'), 'America/New_York').toISOString(), '2026-11-01T14:00:00.000Z');
  // Fixed-offset zone (UTC+3, no DST).
  assert.equal(nextCronTimeInZone(nine, new Date('2026-03-07T00:00:00Z'), 'Asia/Riyadh').toISOString(), '2026-03-07T06:00:00.000Z');
  // UTC and unknown zones fall back to the plain UTC evaluator.
  assert.equal(nextCronTimeInZone(nine, new Date('2026-03-07T00:00:00Z'), 'UTC').toISOString(), nextCronTime(nine, new Date('2026-03-07T00:00:00Z')).toISOString());
  assert.equal(nextCronTimeInZone(nine, new Date('2026-03-07T00:00:00Z'), 'Mars/Phobos').toISOString(), '2026-03-07T09:00:00.000Z');
});

test('computeNextRun honours the trigger timezone for cron', () => {
  const trigger = { kind: 'cron', schedule: '0 9 * * *', timezone: 'America/New_York' };
  assert.equal(computeNextRun(trigger, new Date('2026-03-07T00:00:00Z')).toISOString(), '2026-03-07T14:00:00.000Z');
  const utc = { kind: 'cron', schedule: '0 9 * * *' };
  assert.equal(computeNextRun(utc, new Date('2026-03-07T00:00:00Z')).toISOString(), '2026-03-07T09:00:00.000Z');
});

test('missed-run policy: skip drops the backlog, catchup drains gradually, run_all replays every slot', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const fixedNow = new Date('2026-01-15T12:00:00Z');
    const overdue = '2026-01-15T07:00:00.000Z'; // 5 hourly slots behind `fixedNow`
    const queue = new RunQueue(db, { pollMs: 10 });

    const mk = (policy) => insertTrigger(db, seedData, {
      kind: 'cron', schedule: '0 * * * *', timezone: 'UTC', missed_run_policy: policy,
      next_run_at: overdue, created_at: '2026-01-15T06:00:00.000Z',
    });

    // run_all: fires the due slot AND every missed slot up to now (6 slots).
    const runAll = mk('run_all');
    const sRunAll = new TriggerScheduler(db, { queue, now: () => new Date(fixedNow) });
    const runAllResult = sRunAll.fire(db.get('SELECT * FROM scheduled_triggers WHERE id=?', runAll.id));
    assert.equal(runAllResult.fired, 6, 'run_all replays the whole backlog');
    assert.equal(runAllResult.nextRunAt, '2026-01-15T13:00:00.000Z');
    const runAllRuns = db.all("SELECT * FROM runs WHERE tenant_id=? AND payload_json LIKE ?", seedData.tenantId, `%"triggerId":"${runAll.id}"%`);
    assert.equal(runAllRuns.length, 6);

    // skip: fires once, then jumps past now (backlog dropped).
    const skip = mk('skip');
    const sSkip = new TriggerScheduler(db, { queue, now: () => new Date(fixedNow) });
    const skipResult = sSkip.fire(db.get('SELECT * FROM scheduled_triggers WHERE id=?', skip.id));
    assert.equal(skipResult.fired, 1);
    assert.equal(skipResult.nextRunAt, '2026-01-15T13:00:00.000Z');
    assert.equal(db.get('SELECT retry_count FROM scheduled_triggers WHERE id=?', skip.id).retry_count, 0);

    // catchup: fires once, advances a single slot (still in the past -> drains).
    const catchup = mk('catchup');
    const sCatchup = new TriggerScheduler(db, { queue, now: () => new Date(fixedNow) });
    const catchupResult = sCatchup.fire(db.get('SELECT * FROM scheduled_triggers WHERE id=?', catchup.id));
    assert.equal(catchupResult.fired, 1);
    assert.equal(catchupResult.nextRunAt, '2026-01-15T08:00:00.000Z');

    // A tick with the real clock at `fixedNow`: only `catchup` is still due
    // (skip/run_all jumped past now), so exactly one trigger fires.
    const sched = new TriggerScheduler(db, { queue, now: () => new Date(fixedNow) });
    const tick = await sched.tick();
    assert.equal(tick.fired, 1, 'only the still-overdue catchup trigger remains due');
    assert.deepEqual(tick.ids, [catchup.id]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordError retries with bounded exponential backoff, then gives up and advances', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const fixedNow = new Date('2026-01-15T12:00:00Z');
    const trigger = insertTrigger(db, seedData, {
      kind: 'interval', schedule: '1h', retry_count: 0, max_retries: 2,
      next_run_at: '2026-01-15T11:00:00.000Z', created_at: '2026-01-15T10:00:00.000Z',
    });
    const queue = new RunQueue(db, { pollMs: 10 });
    const scheduler = new TriggerScheduler(db, { queue, now: () => new Date(fixedNow), retryBackoffMs: 60_000 });

    // Attempt 1 -> retry at now + 60s.
    let snapshot = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    let result = scheduler.recordError(snapshot, new Error('boom-1'));
    assert.equal(result.retried, true);
    assert.equal(result.attempt, 1);
    assert.equal(result.nextRunAt, '2026-01-15T12:01:00.000Z');
    let row = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    assert.equal(row.retry_count, 1);
    assert.equal(row.last_error, 'boom-1');

    // Attempt 2 -> retry at now + 120s (backoff doubles).
    snapshot = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    result = scheduler.recordError(snapshot, new Error('boom-2'));
    assert.equal(result.retried, true);
    assert.equal(result.attempt, 2);
    assert.equal(result.nextRunAt, '2026-01-15T12:02:00.000Z');

    // Attempt 3 -> retries exhausted: give up, reset counter, advance normally.
    snapshot = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    result = scheduler.recordError(snapshot, new Error('boom-3'));
    assert.equal(result.retried, false);
    row = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    assert.equal(row.retry_count, 0);
    assert.equal(row.last_error, 'boom-3');
    assert.ok(row.next_run_at > fixedNow.toISOString(), 'schedule advances into the future after giving up');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a successful fire clears the retry counter', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    const fixedNow = new Date('2026-01-15T12:00:00Z');
    const trigger = insertTrigger(db, seedData, {
      kind: 'interval', schedule: '1h', retry_count: 2,
      next_run_at: '2026-01-15T11:00:00.000Z', created_at: '2026-01-15T10:00:00.000Z',
    });
    const queue = new RunQueue(db, { pollMs: 10 });
    const scheduler = new TriggerScheduler(db, { queue, now: () => new Date(fixedNow) });
    scheduler.fire(db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id));
    const row = db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id);
    assert.equal(row.retry_count, 0);
    assert.equal(row.last_error, null);
    assert.equal(row.run_count, 1);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrency cap bounds how many triggers fire at once', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const seedData = seed(db);
    for (let i = 0; i < 6; i += 1) {
      insertTrigger(db, seedData, { next_run_at: new Date(Date.now() - 60_000).toISOString() });
    }
    const queue = new RunQueue(db, { pollMs: 10 });
    const scheduler = new TriggerScheduler(db, { queue, pollMs: 10, concurrency: 2 });

    let inFlight = 0;
    let maxInFlight = 0;
    const fired = [];
    // Replace the real fire with a slow async one to observe the pool.
    scheduler.fire = async (trigger) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      fired.push(trigger.id);
      return { fired: 1 };
    };

    const result = await scheduler.tick();
    assert.equal(result.fired, 6);
    assert.equal(fired.length, 6);
    assert.equal(maxInFlight, 2, 'never more than `concurrency` fires in flight');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('MISSED_RUN_POLICIES is the frozen canonical set', () => {
  assert.deepEqual(MISSED_RUN_POLICIES, ['skip', 'catchup', 'run_all']);
  assert.equal(Object.isFrozen(MISSED_RUN_POLICIES), true);
});
