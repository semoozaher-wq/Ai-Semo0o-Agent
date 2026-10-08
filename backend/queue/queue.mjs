import { id, now } from '../db/client.mjs';

// `continuation` is a transient, non-terminal state: the run stopped at a
// bounded limit (time/step budget) and a continuation run resuming from its
// checkpoint has been scheduled. It is not a failure and not a completion.
export const RUN_STATES = Object.freeze(['queued','running','waiting_approval','blocked','paused','completed','completed_with_warnings','failed','cancelled','unverified','continuation']);

export class RunQueue {
  constructor(db, { pollMs = 100, workerId = id('worker'), leaseMs = 15 * 60_000, maxAttempts = 3, concurrency = 1, retryBackoffMs = 1_000, retryBackoffMaxMs = 60_000, redact = (value) => value } = {}) {
    this.db = db; this.pollMs = pollMs; this.workerId = workerId; this.leaseMs = Math.max(10_000, Number(leaseMs));
    this.maxAttempts = Math.max(1, Number(maxAttempts)); this.concurrency = Math.max(1, Number(concurrency));
    // Bounded exponential backoff between retries so a persistently failing run
    // cannot hot-loop the worker (each retry waits `base * 2^(attempt-1)`, capped).
    // `retryBackoffMs = 0` restores the old immediate-requeue behaviour.
    this.retryBackoffMs = Math.max(0, Number(retryBackoffMs) || 0);
    this.retryBackoffMaxMs = Math.max(this.retryBackoffMs, Number(retryBackoffMaxMs) || 60_000);
    // `redact` is applied to every result persisted as `result_json` (including
    // the error path) so a secret in a thrown error can never reach the database.
    this.redact = typeof redact === 'function' ? redact : (value) => value;
    this.handlers = new Map(); this.timer = null; this.stopped = false; this.processing = 0; this.activeControllers = new Map();
  }
  register(kind, handler) { this.handlers.set(kind, handler); }
  enqueue({ taskId, tenantId, payload, kind = 'code.run', idempotencyKey = null, dedupeActive = false }) {
    const runId = id('run'); const timestamp = now();
    return this.db.transaction(() => {
      if (idempotencyKey) { const existing = this.db.get('SELECT * FROM runs WHERE tenant_id=? AND idempotency_key=?', tenantId, idempotencyKey); if (existing) return existing; }
      // Duplicate active-run protection: when requested, refuse to start a second
      // run for a task that already has an ACTIVE run of the same kind, so a
      // double-submit (or a re-fired trigger) can never execute the same work
      // twice. Returns the existing active run instead of creating a new one.
      if (dedupeActive) {
        const active = this.db.all("SELECT * FROM runs WHERE tenant_id=? AND task_id=? AND status IN ('queued','running','waiting_approval','paused') ORDER BY created_at DESC", tenantId, taskId);
        const duplicate = active.find((row) => { try { return JSON.parse(row.payload_json).kind === kind; } catch { return false; } });
        if (duplicate) return duplicate;
      }
      this.db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'queued', JSON.stringify({ kind, ...payload }), 0, idempotencyKey, timestamp, timestamp);
      this.db.run('UPDATE tasks SET status=?, updated_at=? WHERE id=? AND tenant_id=?', 'queued', timestamp, taskId, tenantId);
      this.db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), tenantId, 'run.queued', 'run', runId, JSON.stringify({ kind }), timestamp);
      return this.db.get('SELECT * FROM runs WHERE id=?', runId);
    });
  }
  start() { if (this.timer) return; this.stopped = false; this.timer = setInterval(() => void this.tick(), this.pollMs); void this.recover(); }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; for (const controller of this.activeControllers.values()) controller.abort(); }
  // Crash/restart recovery. `recover()` is kept as the boot-time entry point and
  // now delegates to `sweep()`, which reconciles every run left in `running`.
  async recover(options) { return this.sweep(options); }
  /**
   * Reconcile orphaned runs. A run left in `running` after a crash/restart is
   * either re-queued (if it can still be retried) or FINALIZED as failed (if its
   * attempts are exhausted, or no worker owns it) so it can never sit in
   * `running` forever. Idempotent and safe to call on every boot. Returns a
   * summary of what was reconciled.
   */
  async sweep({ orphanMs = 0 } = {}) {
    const timestamp = now();
    const cutoff = new Date(Date.now() - Math.max(0, Number(orphanMs) || 0)).toISOString();
    // 1. Re-queue a still-retryable run whose lease expired (existing behaviour).
    const requeued = this.db.run("UPDATE runs SET status='queued', worker_id=NULL, lease_until=NULL, next_attempt_at=NULL, updated_at=? WHERE status='running' AND attempts<? AND (lease_until IS NULL OR lease_until<?)", timestamp, this.maxAttempts, cutoff);
    // 2. Finalize the orphans that can no longer run (attempts exhausted or no
    //    owning worker), so `running` never leaks a dead run.
    const orphans = this.db.all("SELECT id, task_id, tenant_id FROM runs WHERE status='running' AND (attempts>=? OR worker_id IS NULL) AND (lease_until IS NULL OR lease_until<?)", this.maxAttempts, cutoff);
    if (orphans.length) {
      this.db.transaction(() => {
        for (const orphan of orphans) {
          const changed = this.db.run("UPDATE runs SET status='failed', worker_id=NULL, lease_until=NULL, result_json=?, updated_at=? WHERE id=? AND status='running'", JSON.stringify(this.redact({ error: 'ORPHANED_RUN_RECOVERED', recovered: true })), timestamp, orphan.id);
          if (changed.changes !== 1) continue;
          this.db.run("UPDATE tasks SET status='failed', updated_at=? WHERE id=? AND status='running'", timestamp, orphan.task_id);
          this.db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), orphan.tenant_id, 'run.recovered_orphan', 'run', orphan.id, JSON.stringify({ recovered: true }), timestamp);
        }
      });
    }
    return { requeued: requeued.changes ?? 0, finalized: orphans.length };
  }
  async tick() {
    if (this.stopped || this.processing >= this.concurrency) return;
    this.processing += 1;
    const run = this.db.transaction(() => {
      const candidate = this.db.get("SELECT * FROM runs WHERE status='queued' AND attempts<? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT 1", this.maxAttempts, now());
      if (!candidate) return null;
      const lease = new Date(Date.now() + this.leaseMs).toISOString();
      this.db.run("UPDATE runs SET status='running', attempts=attempts+1, worker_id=?, lease_until=?, next_attempt_at=NULL, updated_at=? WHERE id=? AND status='queued'", this.workerId, lease, now(), candidate.id);
      this.db.run("UPDATE tasks SET status='running', updated_at=? WHERE id=?", now(), candidate.task_id);
      return this.db.get('SELECT * FROM runs WHERE id=?', candidate.id);
    });
    if (!run) { this.processing -= 1; return; }
    const payload = JSON.parse(run.payload_json); const handler = this.handlers.get(payload.kind);
    if (!handler) { await this.finish(run, 'failed', { error: `NO_HANDLER:${payload.kind}` }); this.processing -= 1; return; }
    const controller = new AbortController(); this.activeControllers.set(run.id, controller);
    const heartbeat = setInterval(() => { this.db.run("UPDATE runs SET lease_until=?, updated_at=? WHERE id=? AND worker_id=? AND status='running'", new Date(Date.now() + this.leaseMs).toISOString(), now(), run.id, this.workerId); }, Math.min(30_000, this.leaseMs / 3));
    try {
      const result = await handler({ run, payload, signal: controller.signal });
      const currentStatus = this.db.get('SELECT status FROM runs WHERE id=?', run.id)?.status;
      if (currentStatus === 'cancelled' || currentStatus === 'paused') return;
      await this.finish(run, result?.status ?? 'completed', result);
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        if (run.attempts < this.maxAttempts) {
          // Bounded exponential backoff: attempt 1 waits `retryBackoffMs`,
          // attempt 2 waits `2x`, ... capped at `retryBackoffMaxMs`.
          const backoff = Math.min(this.retryBackoffMaxMs, this.retryBackoffMs * 2 ** Math.max(0, run.attempts - 1));
          const nextAttemptAt = backoff > 0 ? new Date(Date.now() + backoff).toISOString() : null;
          this.db.run("UPDATE runs SET status='queued', worker_id=NULL, lease_until=NULL, next_attempt_at=?, result_json=?, updated_at=? WHERE id=? AND status='running'", nextAttemptAt, JSON.stringify(this.redact({ error: message, retrying: true, nextAttemptAt })), now(), run.id);
          this.db.run("UPDATE tasks SET status='queued', updated_at=? WHERE id=?", now(), run.task_id);
        } else await this.finish(run, 'failed', { error: message, attempts: run.attempts });
      }
    } finally { clearInterval(heartbeat); this.db.run("UPDATE runs SET lease_until=NULL WHERE id=? AND worker_id=?", run.id, this.workerId); this.activeControllers.delete(run.id); this.processing -= 1; }
  }
  async finish(run, status, result) {
    const timestamp = now(); this.db.transaction(() => {
      const changed = this.db.run("UPDATE runs SET status=?, result_json=?, worker_id=NULL, lease_until=NULL, updated_at=? WHERE id=? AND status='running' AND worker_id=?", status, JSON.stringify(this.redact(result ?? {})), timestamp, run.id, this.workerId);
      if (changed.changes !== 1) return;
      // A run that handed off to a scheduled continuation leaves the TASK queued
      // (the continuation run is pending), not terminal, so the task status never
      // flickers to a terminal state while work is still outstanding.
      const taskStatus = result?.continuation?.scheduled === true ? 'queued' : status;
      this.db.run('UPDATE tasks SET status=?, updated_at=? WHERE id=?', taskStatus, timestamp, run.task_id);
      this.db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), run.tenant_id, `run.${status}`, 'run', run.id, JSON.stringify({ attempts: run.attempts }), timestamp);
    });
  }
  get(runId, tenantId) { return this.db.get('SELECT * FROM runs WHERE id=? AND tenant_id=?', runId, tenantId); }
  cancel(runId, tenantId) { return this.transition(runId, tenantId, ['queued','running','paused','waiting_approval'], 'cancelled'); }
  pause(runId, tenantId) { return this.transition(runId, tenantId, ['queued','running'], 'paused'); }
  resume(runId, tenantId) { return this.transition(runId, tenantId, ['paused'], 'queued'); }
  retry(runId, tenantId) {
    const result = this.db.run("UPDATE runs SET status='queued', attempts=0, next_attempt_at=NULL, result_json=NULL, updated_at=? WHERE id=? AND tenant_id=? AND status IN ('failed','cancelled','unverified','completed_with_warnings')", now(), runId, tenantId);
    if (result.changes !== 1) throw new Error('INVALID_RETRY_TRANSITION');
    this.db.run("UPDATE tasks SET status='queued', updated_at=? WHERE id=(SELECT task_id FROM runs WHERE id=?)", now(), runId); return this.get(runId, tenantId);
  }
  transition(runId, tenantId, from, to) {
    if (!RUN_STATES.includes(to)) throw new Error('INVALID_RUN_STATE');
    const result = this.db.run(`UPDATE runs SET status=?, updated_at=? WHERE id=? AND tenant_id=? AND status IN (${from.map(() => '?').join(',')})`, to, now(), runId, tenantId, ...from);
    if (result.changes !== 1) throw new Error('INVALID_RUN_TRANSITION');
    if (to === 'cancelled' || to === 'paused') this.activeControllers.get(runId)?.abort();
    this.db.run('UPDATE tasks SET status=?, updated_at=? WHERE id=(SELECT task_id FROM runs WHERE id=?)', to, now(), runId); return this.get(runId, tenantId);
  }
}
