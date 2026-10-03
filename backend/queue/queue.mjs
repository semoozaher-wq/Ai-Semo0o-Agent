import { id, now } from '../db/client.mjs';

export const RUN_STATES = Object.freeze(['queued','running','waiting_approval','blocked','paused','completed','completed_with_warnings','failed','cancelled','unverified']);

export class RunQueue {
  constructor(db, { pollMs = 100, workerId = id('worker') } = {}) {
    this.db = db;
    this.pollMs = pollMs;
    this.workerId = workerId;
    this.handlers = new Map();
    this.timer = null;
    this.stopped = false;
  }
  register(kind, handler) { this.handlers.set(kind, handler); }
  enqueue({ taskId, tenantId, payload, kind = 'code.run' }) {
    const runId = id('run');
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'queued', JSON.stringify({ kind, ...payload }), 0, timestamp, timestamp);
      this.db.run('UPDATE tasks SET status=?, updated_at=? WHERE id=? AND tenant_id=?', 'queued', timestamp, taskId, tenantId);
      this.db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), tenantId, 'run.queued', 'run', runId, JSON.stringify({ kind }), timestamp);
    });
    return this.db.get('SELECT * FROM runs WHERE id=?', runId);
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    void this.recover();
  }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  async recover() {
    this.db.run("UPDATE runs SET status='queued', updated_at=? WHERE status='running'", now());
  }
  async tick() {
    if (this.stopped) return;
    const run = this.db.transaction(() => {
      const candidate = this.db.get("SELECT * FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1");
      if (!candidate) return null;
      this.db.run("UPDATE runs SET status='running', attempts=attempts+1, updated_at=? WHERE id=? AND status='queued'", now(), candidate.id);
      this.db.run("UPDATE tasks SET status='running', updated_at=? WHERE id=?", now(), candidate.task_id);
      return this.db.get('SELECT * FROM runs WHERE id=?', candidate.id);
    });
    if (!run) return;
    const payload = JSON.parse(run.payload_json);
    const handler = this.handlers.get(payload.kind);
    if (!handler) return this.finish(run, 'failed', { error: `NO_HANDLER:${payload.kind}` });
    try {
      const result = await handler({ run, payload });
      if (this.db.get("SELECT status FROM runs WHERE id=?", run.id)?.status === 'cancelled') return;
      await this.finish(run, result?.status ?? 'completed', result);
    } catch (error) {
      await this.finish(run, 'failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  async finish(run, status, result) {
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run('UPDATE runs SET status=?, result_json=?, updated_at=? WHERE id=?', status, JSON.stringify(result ?? {}), timestamp, run.id);
      this.db.run('UPDATE tasks SET status=?, updated_at=? WHERE id=?', status, timestamp, run.task_id);
      this.db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), run.tenant_id, `run.${status}`, 'run', run.id, JSON.stringify({ attempts: run.attempts }), timestamp);
    });
  }
  get(runId, tenantId) { return this.db.get('SELECT * FROM runs WHERE id=? AND tenant_id=?', runId, tenantId); }
  cancel(runId, tenantId) { return this.transition(runId, tenantId, ['queued','running','paused','waiting_approval'], 'cancelled'); }
  pause(runId, tenantId) { return this.transition(runId, tenantId, ['queued','running'], 'paused'); }
  resume(runId, tenantId) { return this.transition(runId, tenantId, ['paused'], 'queued'); }
  transition(runId, tenantId, from, to) {
    if (!RUN_STATES.includes(to)) throw new Error('INVALID_RUN_STATE');
    const result = this.db.run(`UPDATE runs SET status=?, updated_at=? WHERE id=? AND tenant_id=? AND status IN (${from.map(() => '?').join(',')})`, to, now(), runId, tenantId, ...from);
    if (result.changes !== 1) throw new Error('INVALID_RUN_TRANSITION');
    this.db.run('UPDATE tasks SET status=?, updated_at=? WHERE id=(SELECT task_id FROM runs WHERE id=?)', to, now(), runId);
    return this.get(runId, tenantId);
  }
}
