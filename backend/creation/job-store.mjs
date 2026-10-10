import { createHash } from 'node:crypto';

// =============================================================================
// backend/creation/job-store.mjs
// -----------------------------------------------------------------------------
// Durable, write-through persistence for the Creation Studio.
//
// The Director is long-running and stateful, but its jobs used to live only in a
// bounded in-memory Map: a restart lost every job AND every artifact it had
// produced. This store makes the registry durable without changing any of the
// studio's public behaviour:
//
//   * the job row (state, progress, result manifest) is upserted on start and on
//     every terminal transition;
//   * every streamed event is appended to an immutable, replayable log;
//   * the artifact BYTES are stored as a BLOB with a SHA-256, so a restore can
//     prove the deliverable is intact.
//
// Storing the bytes in the database (rather than on a side directory) keeps a job
// and its deliverables atomic with the rest of the platform: the existing
// encrypted backup is a single VACUUM INTO snapshot, so one backup captures the
// job, its events and its artifacts together and one restore brings them all
// back. Every write is best-effort from the studio's point of view - a storage
// hiccup must never break a running job - so callers wrap these in try/catch.
// =============================================================================

const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024; // 64 MB hard cap per artifact (mirrors the artifact ledger)

const nowIso = () => new Date().toISOString();
const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

const MIME_BY_NAME = Object.freeze({
  gif: 'image/gif',
  avi: 'video/x-msvideo',
  bundle: 'application/zip',
  mp4: 'video/mp4',
});

/** MIME type for a known artifact slot; defaults to a generic binary type. */
export function artifactMimeType(name) {
  return MIME_BY_NAME[name] ?? 'application/octet-stream';
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export class CreationJobStore {
  constructor(db, { maxArtifactBytes = MAX_ARTIFACT_BYTES } = {}) {
    if (!db) throw new Error('CREATION_JOB_STORE_DB_REQUIRED');
    this.db = db;
    this.maxArtifactBytes = maxArtifactBytes;
  }

  /** Upsert the job row (state + manifest). Never touches events/artifacts. */
  saveJob(job) {
    if (!job?.id) throw new Error('CREATION_JOB_STORE_JOB_REQUIRED');
    this.db.run(
      `INSERT INTO creation_jobs(id,tenant_id,user_id,goal,options_json,status,created_at,updated_at,started_at,elapsed_ms,progress_json,result_json,error)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         tenant_id=excluded.tenant_id,
         user_id=excluded.user_id,
         goal=excluded.goal,
         options_json=excluded.options_json,
         status=excluded.status,
         updated_at=excluded.updated_at,
         started_at=excluded.started_at,
         elapsed_ms=excluded.elapsed_ms,
         progress_json=excluded.progress_json,
         result_json=excluded.result_json,
         error=excluded.error`,
      job.id,
      job.tenantId ?? null,
      job.userId ?? null,
      job.goal ?? '',
      JSON.stringify(job.options ?? {}),
      job.status ?? 'running',
      job.createdAt ?? nowIso(),
      job.updatedAt ?? nowIso(),
      job.startedAt ? new Date(job.startedAt).toISOString() : null,
      Number.isFinite(job.elapsedMs) ? job.elapsedMs : 0,
      JSON.stringify(job.progress ?? {}),
      job.result ? JSON.stringify(job.result) : null,
      job.error ?? null,
    );
    return job.id;
  }

  /** Append one event to the immutable log (idempotent on (job_id, seq)). */
  appendEvent(jobId, tenantId, event) {
    if (!jobId || !event) return;
    this.db.run(
      `INSERT INTO creation_job_events(job_id,tenant_id,seq,type,payload_json,at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(job_id, seq) DO NOTHING`,
      jobId,
      tenantId ?? null,
      Number(event.seq) || 0,
      String(event.type ?? 'event'),
      JSON.stringify(event.payload ?? {}),
      event.at ?? nowIso(),
    );
  }

  /**
   * Persist artifact buffers as BLOBs. `artifacts` is the studio's
   * `{ gif, avi, bundle, mp4 }` map of Buffers (missing/null slots are skipped).
   * Oversized buffers are skipped rather than silently truncated.
   */
  saveArtifacts(jobId, tenantId, artifacts = {}) {
    if (!jobId) return [];
    const stored = [];
    for (const [name, buffer] of Object.entries(artifacts)) {
      if (!buffer) continue;
      const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      if (bytes.length === 0 || bytes.length > this.maxArtifactBytes) continue;
      const mimeType = artifactMimeType(name);
      const digest = sha256Hex(bytes);
      this.db.run(
        `INSERT INTO creation_job_artifacts(job_id,tenant_id,name,bytes,mime_type,sha256,content,created_at)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(job_id, name) DO UPDATE SET
           tenant_id=excluded.tenant_id,
           bytes=excluded.bytes,
           mime_type=excluded.mime_type,
           sha256=excluded.sha256,
           content=excluded.content,
           created_at=excluded.created_at`,
        jobId, tenantId ?? null, name, bytes.length, mimeType, digest, bytes, nowIso(),
      );
      stored.push({ name, bytes: bytes.length, mimeType, sha256: digest });
    }
    return stored;
  }

  /** Metadata for every artifact of a job (no bytes) - cheap for list/status. */
  loadArtifactMeta(jobId) {
    const rows = this.db.all(
      'SELECT name,bytes,mime_type,sha256 FROM creation_job_artifacts WHERE job_id=?',
      jobId,
    );
    const meta = {};
    for (const row of rows) meta[row.name] = { bytes: row.bytes, mimeType: row.mime_type, sha256: row.sha256 };
    return meta;
  }

  /** Full artifact (bytes + mime + verified hash) or null. */
  loadArtifact(jobId, name) {
    const row = this.db.get(
      'SELECT bytes,mime_type,sha256,content FROM creation_job_artifacts WHERE job_id=? AND name=?',
      jobId, name,
    );
    if (!row || !row.content) return null;
    const buffer = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    return { buffer, mimeType: row.mime_type, bytes: row.bytes, sha256: row.sha256 };
  }

  /** Re-hash a stored artifact and report the REAL result (never assumes). */
  verifyArtifact(jobId, name) {
    const row = this.db.get(
      'SELECT sha256,content FROM creation_job_artifacts WHERE job_id=? AND name=?',
      jobId, name,
    );
    if (!row || !row.content) return { ok: false, reason: 'CREATION_ARTIFACT_NOT_FOUND' };
    const buffer = Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content);
    const actual = sha256Hex(buffer);
    return { ok: actual === row.sha256, expected: row.sha256, actual, bytes: buffer.length };
  }

  /** Hydrate a single job row into the studio's in-memory job shape. */
  loadJob(id) {
    const row = this.db.get('SELECT * FROM creation_jobs WHERE id=?', id);
    if (!row) return null;
    return this.#rowToJob(row);
  }

  /** Most recent jobs for a tenant (or unowned/system jobs when tenantId=null). */
  listJobs(tenantId = null, limit = 50) {
    const rows = this.db.all(
      `SELECT * FROM creation_jobs
       WHERE (tenant_id IS ? OR tenant_id = ?)
       ORDER BY created_at DESC LIMIT ?`,
      tenantId ?? null, tenantId ?? null, Math.max(1, Math.floor(limit) || 50),
    );
    return rows.map((row) => this.#rowToJob(row));
  }

  /** Most recent jobs across ALL tenants - used to warm the bounded registry. */
  listAll(limit = 200) {
    const rows = this.db.all(
      'SELECT * FROM creation_jobs ORDER BY created_at DESC LIMIT ?',
      Math.max(1, Math.floor(limit) || 200),
    );
    return rows.map((row) => this.#rowToJob(row));
  }

  /** Replayable events for a job, strictly after `sinceSeq`. */
  loadEvents(jobId, sinceSeq = 0) {
    const rows = this.db.all(
      'SELECT seq,type,payload_json,at FROM creation_job_events WHERE job_id=? AND seq>? ORDER BY seq ASC',
      jobId, Number(sinceSeq) || 0,
    );
    return rows.map((row) => ({ seq: row.seq, type: row.type, payload: parseJson(row.payload_json, {}), at: row.at }));
  }

  /** Highest event sequence persisted for a job (0 when none). */
  maxSeq(jobId) {
    const row = this.db.get('SELECT MAX(seq) AS max_seq FROM creation_job_events WHERE job_id=?', jobId);
    return Number(row?.max_seq) || 0;
  }

  /** Highest event sequence across the whole log (used to seed the studio seq). */
  globalMaxSeq() {
    const row = this.db.get('SELECT MAX(seq) AS max_seq FROM creation_job_events');
    return Number(row?.max_seq) || 0;
  }

  /** Jobs that were still 'running' when the process stopped (interrupted). */
  interrupted() {
    const rows = this.db.all("SELECT * FROM creation_jobs WHERE status='running' ORDER BY created_at ASC");
    return rows.map((row) => this.#rowToJob(row));
  }

  /** Delete a job and everything it owns (used by retention pruning). */
  deleteJob(id) {
    this.db.transaction((tx) => {
      tx.run('DELETE FROM creation_job_artifacts WHERE job_id=?', id);
      tx.run('DELETE FROM creation_job_events WHERE job_id=?', id);
      tx.run('DELETE FROM creation_jobs WHERE id=?', id);
    });
    return id;
  }

  /**
   * Bounded retention so the durable registry cannot grow without limit. Keeps
   * the newest `keepPerTenant` jobs per tenant and drops anything older than
   * `maxAgeMs`. Only TERMINAL jobs are ever pruned - a running job is never
   * deleted out from under the Director.
   */
  prune({ maxAgeMs = 30 * 24 * 60 * 60 * 1000, keepPerTenant = 500 } = {}) {
    const cutoff = new Date(Date.now() - Math.max(0, maxAgeMs)).toISOString();
    const expired = this.db.all(
      "SELECT id FROM creation_jobs WHERE status IN ('completed','failed','cancelled') AND updated_at < ?",
      cutoff,
    );
    let removed = 0;
    for (const row of expired) { this.deleteJob(row.id); removed += 1; }
    const tenants = this.db.all('SELECT DISTINCT tenant_id FROM creation_jobs');
    for (const { tenant_id: tenantId } of tenants) {
      const surplus = this.db.all(
        `SELECT id FROM creation_jobs
         WHERE (tenant_id IS ? OR tenant_id = ?) AND status IN ('completed','failed','cancelled')
         ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
        tenantId ?? null, tenantId ?? null, Math.max(1, Math.floor(keepPerTenant) || 500),
      );
      for (const row of surplus) { this.deleteJob(row.id); removed += 1; }
    }
    return { removed };
  }

  #rowToJob(row) {
    return {
      id: row.id,
      tenantId: row.tenant_id ?? null,
      userId: row.user_id ?? null,
      goal: row.goal,
      options: parseJson(row.options_json, {}),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ? new Date(row.started_at).getTime() : null,
      elapsedMs: Number(row.elapsed_ms) || 0,
      progress: parseJson(row.progress_json, {}),
      result: parseJson(row.result_json, null),
      error: row.error ?? null,
      events: [],
      listeners: new Set(),
      artifacts: {},
      artifactMeta: {},
      controller: null,
      hydrated: true,
    };
  }
}

export { MAX_ARTIFACT_BYTES };
