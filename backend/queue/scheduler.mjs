import { id, now } from '../db/client.mjs';

// =============================================================================
// backend/queue/scheduler.mjs
// -----------------------------------------------------------------------------
// Scheduled / recurring autonomy for the platform.
//
// The RunQueue (backend/queue/queue.mjs) already turns queued runs into executed
// work. What was missing is a way to *create* work on a schedule: "every Monday
// at 09:00 run the dependency audit", "every 15 minutes re-check the deploy",
// "at this exact time, once". This module adds exactly that, additively:
//
//   - a small, dependency-free cron parser (standard 5-field: min hour dom
//     month dow) plus `interval` ("15m", "2h", "1d") and `once` (ISO timestamp)
//     schedule kinds;
//   - a `TriggerScheduler` that, on each tick, finds due triggers, creates the
//     task and enqueues the run through the SAME RunQueue the rest of the
//     platform uses (idempotent per fire time, so a double tick can never
//     double-fire), then advances the trigger's `next_run_at`.
//
// It introduces no new execution path and no new worker: a scheduled run is an
// ordinary queued run and is processed by the ordinary worker.
// =============================================================================

export const TRIGGER_KINDS = Object.freeze(['cron', 'interval', 'once']);

const CRON_FIELDS = Object.freeze(['minute', 'hour', 'dom', 'month', 'dow']);
const CRON_RANGES = Object.freeze({ minute: [0, 59], hour: [0, 23], dom: [1, 31], month: [1, 12], dow: [0, 6] });

// Expand a single cron field ("*", "5", "1-10", step values, comma lists) into a Set.
function expandField(field, [min, max]) {
  const set = new Set();
  for (const part of String(field).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error('CRON_STEP_INVALID');
    let start;
    let end;
    if (range === '*') { start = min; end = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-').map(Number); start = a; end = b; }
    else { const value = Number(range); start = value; end = stepRaw === undefined ? value : max; }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) throw new Error('CRON_FIELD_OUT_OF_RANGE');
    for (let value = start; value <= end; value += step) set.add(value);
  }
  if (set.size === 0) throw new Error('CRON_FIELD_EMPTY');
  return set;
}

/**
 * Parse a standard 5-field cron expression. Day-of-week accepts 0..6 (0=Sunday)
 * and also 7 as an alias for Sunday. Returns the expanded field sets plus the
 * `domStar`/`dowStar` flags needed to apply the standard Vixie-cron OR rule.
 */
export function parseCron(expression) {
  const parts = String(expression).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('CRON_FIELD_COUNT_INVALID');
  const parsed = {};
  parts.forEach((field, index) => {
    const name = CRON_FIELDS[index];
    // Day-of-week accepts 0..6 (0=Sunday) and also 7 as an alias for Sunday, so
    // it is expanded over 0..7 and then folded back down to 0..6.
    const range = name === 'dow' ? [0, 7] : CRON_RANGES[name];
    const set = expandField(field, range);
    if (name === 'dow' && set.has(7)) { set.delete(7); set.add(0); }
    parsed[name] = set;
  });
  parsed.domStar = parts[2] === '*';
  parsed.dowStar = parts[4] === '*';
  return parsed;
}

/** Parse an interval string ("30s", "15m", "2h", "1d") into milliseconds. */
export function parseInterval(value) {
  const match = String(value).trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) throw new Error('INTERVAL_INVALID');
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('INTERVAL_INVALID');
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2].toLowerCase()];
  return amount * unit;
}

/** Validate a schedule for a kind and return its normalised form. */
export function normalizeSchedule(kind, schedule) {
  if (!TRIGGER_KINDS.includes(kind)) throw new Error('TRIGGER_KIND_INVALID');
  if (kind === 'once') {
    const at = new Date(String(schedule));
    if (Number.isNaN(at.getTime())) throw new Error('SCHEDULE_ONCE_INVALID');
    return at.toISOString();
  }
  if (kind === 'interval') { parseInterval(schedule); return String(schedule).trim(); }
  parseCron(schedule); return String(schedule).trim();
}

/**
 * The next time a trigger should fire, strictly after `from` (UTC). Returns null
 * for a `once` trigger whose moment has already passed. Pure and side-effect free
 * so it is trivially unit-testable.
 */
export function computeNextRun(trigger, from = new Date()) {
  const fromMs = from.getTime();
  if (trigger.kind === 'once') {
    const at = new Date(trigger.schedule).getTime();
    return Number.isFinite(at) && at > fromMs ? new Date(at) : null;
  }
  if (trigger.kind === 'interval') {
    const intervalMs = parseInterval(trigger.schedule);
    const anchor = new Date(trigger.created_at || from).getTime();
    if (fromMs < anchor) return new Date(anchor);
    const steps = Math.floor((fromMs - anchor) / intervalMs) + 1;
    return new Date(anchor + steps * intervalMs);
  }
  if (trigger.kind === 'cron') return nextCronTime(parseCron(trigger.schedule), from);
  throw new Error('TRIGGER_KIND_INVALID');
}

/** Next cron fire time strictly after `from`, evaluated in UTC. */
export function nextCronTime(parsed, from = new Date()) {
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = cursor.getTime() + 366 * 4 * 86_400_000; // search up to ~4 years
  while (cursor.getTime() <= limit) {
    if (!parsed.month.has(cursor.getUTCMonth() + 1)) { cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1); cursor.setUTCHours(0, 0, 0, 0); continue; }
    const domMatch = parsed.dom.has(cursor.getUTCDate());
    const dowMatch = parsed.dow.has(cursor.getUTCDay());
    const dayMatch = (!parsed.domStar && !parsed.dowStar) ? (domMatch || dowMatch) : (domMatch && dowMatch);
    if (!dayMatch) { cursor.setUTCDate(cursor.getUTCDate() + 1); cursor.setUTCHours(0, 0, 0, 0); continue; }
    if (!parsed.hour.has(cursor.getUTCHours())) { cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0); continue; }
    if (!parsed.minute.has(cursor.getUTCMinutes())) { cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0); continue; }
    return new Date(cursor.getTime());
  }
  return null;
}

/**
 * The scheduler. It owns no timer of its own beyond a poll interval and does no
 * work unless `start()` is called, so constructing it in the server/worker is
 * side-effect free and safe for tests.
 */
export class TriggerScheduler {
  constructor(db, { queue, pollMs = 30_000, now: nowFn = () => new Date(), maxPerTick = 50 } = {}) {
    if (!db || !queue) throw new Error('SCHEDULER_DEPENDENCIES_REQUIRED');
    this.db = db;
    this.queue = queue;
    this.pollMs = Math.max(1_000, Number(pollMs) || 30_000);
    this.now = typeof nowFn === 'function' ? nowFn : () => new Date();
    this.maxPerTick = Math.max(1, Number(maxPerTick) || 50);
    this.timer = null;
    this.stopped = false;
    this.processing = false;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fire every due trigger once. Returns a small, honest summary. */
  async tick() {
    if (this.stopped || this.processing) return { fired: 0, ids: [] };
    this.processing = true;
    const ids = [];
    try {
      const nowIso = this.now().toISOString();
      const due = this.db.all(
        'SELECT * FROM scheduled_triggers WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT ?',
        nowIso, this.maxPerTick,
      );
      for (const trigger of due) {
        try { this.fire(trigger); ids.push(trigger.id); }
        catch (error) { this.recordError(trigger, error); }
      }
    } finally {
      this.processing = false;
    }
    return { fired: ids.length, ids };
  }

  /** Create the task and enqueue its run for one trigger fire (idempotent). */
  fire(trigger) {
    const fireTime = trigger.next_run_at || this.now().toISOString();
    const next = computeNextRun(trigger, new Date(fireTime));
    return this.db.transaction(() => {
      const workspaceId = trigger.workspace_id
        || this.db.get('SELECT id FROM workspaces WHERE project_id=? ORDER BY created_at LIMIT 1', trigger.project_id)?.id;
      if (!workspaceId) throw new Error('TRIGGER_WORKSPACE_REQUIRED');
      const payload = { ...JSON.parse(trigger.payload_json || '{}'), goal: trigger.goal, triggerId: trigger.id };
      const kind = payload.kind || 'agent.run';
      const taskId = id('task');
      const timestamp = now();
      this.db.run(
        'INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        taskId, trigger.tenant_id, trigger.project_id, workspaceId, trigger.created_by, trigger.goal, 'queued', timestamp, timestamp,
      );
      this.queue.enqueue({ taskId, tenantId: trigger.tenant_id, payload, kind, idempotencyKey: `trigger:${trigger.id}:${fireTime}` });
      this.db.run(
        'UPDATE scheduled_triggers SET last_run_at=?, next_run_at=?, run_count=run_count+1, last_error=NULL, updated_at=? WHERE id=?',
        fireTime, next ? next.toISOString() : null, timestamp, trigger.id,
      );
      this.db.run(
        'INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
        id('audit'), trigger.tenant_id, 'trigger.fired', 'scheduled_trigger', trigger.id,
        JSON.stringify({ fireTime, next: next ? next.toISOString() : null, taskId }), timestamp,
      );
      return { taskId, nextRunAt: next ? next.toISOString() : null };
    });
  }

  /** Record a fire failure without wedging the scheduler; advance the schedule. */
  recordError(trigger, error) {
    const timestamp = now();
    let next = null;
    try { next = computeNextRun(trigger, new Date()); } catch { next = null; }
    this.db.run(
      'UPDATE scheduled_triggers SET last_error=?, next_run_at=?, updated_at=? WHERE id=?',
      String(error?.message || error).slice(0, 500), next ? next.toISOString() : null, timestamp, trigger.id,
    );
  }
}

export function createTriggerScheduler(opts) {
  return new TriggerScheduler(opts.db, opts);
}
