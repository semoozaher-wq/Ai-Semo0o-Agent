// Creation Studio — the async job layer behind the /creation/* API.
//
// The Director is a long, stateful process (think → plan → render → critique →
// improve → deliver). This module turns it into a first-class, observable job:
// start it, stream its events, poll its status, download its artefacts, cancel
// it. It is deliberately transport-agnostic (no HTTP here) so it can be unit
// tested and reused by the queue, a CLI or a worker.
//
// Jobs are kept in a bounded, TTL-evicted in-memory registry for fast access.
// When a database is supplied the registry is ALSO durable (write-through via
// CreationJobStore): the job row, its event log and its artifact bytes are
// persisted, so a completed deliverable is still listable and downloadable after
// a restart and a job that was mid-flight when the process stopped is honestly
// reported as interrupted instead of silently vanishing. Absent a database the
// studio is in-memory only, exactly as before.

import { runDirector, planCreation } from './director.mjs';
import { createCreationProviders } from './providers.mjs';
import { CreationJobStore } from './job-store.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

// A job that was still 'running' when the process stopped cannot be resumed
// mid-render (the Director holds no durable checkpoint), so it is honestly
// reported as interrupted on the next boot rather than silently vanishing.
const INTERRUPTED = 'CREATION_INTERRUPTED_BY_RESTART';

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {object} [options]
 * @param {object} [options.llm]      server LLM router (optional; deterministic fallback is used when absent).
 * @param {object} [options.providers] pre-built CreationProviders (optional).
 * @param {object} [options.db]       database handle; when given, jobs are persisted durably (write-through).
 * @param {object} [options.store]    a pre-built CreationJobStore (overrides `db`).
 * @param {number} [options.maxJobs]  bounded registry size (default 40).
 * @param {number} [options.ttlMs]    eviction age for terminal jobs (default 1h).
 */
export class CreationStudio {
  constructor({ llm = null, providers = null, db = null, store = null, maxJobs = 40, ttlMs = 60 * 60 * 1000, env = process.env } = {}) {
    this.llm = llm;
    this.providers = providers || createCreationProviders(env);
    this.maxJobs = Math.max(1, maxJobs);
    this.ttlMs = Math.max(60_000, ttlMs);
    this.jobs = new Map();
    this.seq = 0;
    // Durable, write-through persistence. When a store is present the registry
    // survives restarts: completed jobs and their artifacts are rehydrated on
    // boot and interrupted jobs are honestly reported. Absent a store the studio
    // behaves exactly as before (in-memory only), so unit tests are unaffected.
    this.store = store || (db ? new CreationJobStore(db) : null);
    this.lastPruneAt = 0;
    if (this.store) this.#hydrate();
  }

  /**
   * Warm the bounded in-memory registry from the durable store and honestly
   * close out any job that was mid-flight when the process last stopped.
   */
  #hydrate() {
    let loaded = 0;
    try {
      const rows = this.store.listAll(this.maxJobs);
      for (const job of rows) {
        job.events = this.store.loadEvents(job.id, 0).slice(-2000);
        job.artifactMeta = this.store.loadArtifactMeta(job.id);
        this.jobs.set(job.id, job);
        loaded += 1;
      }
      // Seed the global event sequence so new events never collide with a
      // replayed one (the log's primary key is (job_id, seq)).
      this.seq = Math.max(this.seq, this.store.globalMaxSeq());
      for (const interrupted of this.store.interrupted()) {
        // Mark the SAME instance that is in the registry (it was already loaded
        // by listAll above) so the correction is visible to callers.
        const job = this.jobs.get(interrupted.id) || interrupted;
        job.status = 'failed';
        job.error = INTERRUPTED;
        job.updatedAt = nowIso();
        job.elapsedMs = job.elapsedMs || 0;
        const event = { seq: ++this.seq, type: 'job.failed', payload: { error: INTERRUPTED, reason: 'process_restart' }, at: job.updatedAt };
        job.events.push(event);
        try { this.store.saveJob(job); this.store.appendEvent(job.id, job.tenantId, event); } catch { /* best effort */ }
        this.jobs.set(job.id, job);
      }
    } catch { /* a hydration failure must never stop the studio from booting */ }
    this.hydratedCount = loaded;
  }

  /** Summary of what was recovered from durable storage on boot (observability). */
  recovery() {
    if (!this.store) return { durable: false, loaded: 0, interrupted: 0 };
    let interrupted = 0;
    try { interrupted = this.store.interrupted().length; } catch { interrupted = 0; }
    return { durable: true, loaded: this.hydratedCount || 0, interrupted };
  }

  capabilities() {
    return {
      kernel: true,
      localStudio: true,
      providers: this.providers.capabilities,
      // Additive real-video capability (does not change the deterministic
      // `formats` contract above). `available` is true only when a real
      // video-generation provider is configured.
      video: this.providers.video
        ? { id: this.providers.video.id, model: this.providers.video.model, capabilities: this.providers.video.capabilities || {}, formats: ['mp4'] }
        : null,
      videoEdit: this.providers.videoEdit ? { id: this.providers.videoEdit.id, model: this.providers.videoEdit.model, formats: ['mp4'] } : null,
      formats: ['gif', 'avi', 'png', 'bundle'],
      resolutions: ['draft', 'standard', 'high', 'full'],
    };
  }

  #evict() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, job] of this.jobs) {
      if (TERMINAL.has(job.status) && new Date(job.updatedAt).getTime() < cutoff) this.jobs.delete(id);
    }
    if (this.jobs.size <= this.maxJobs) return;
    const ordered = [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    while (this.jobs.size > this.maxJobs && ordered.length) {
      const victim = ordered.shift();
      if (TERMINAL.has(victim.status)) this.jobs.delete(victim.id);
    }
  }

  #push(job, type, payload) {
    const event = { seq: ++this.seq, type, payload: payload || {}, at: nowIso() };
    job.events.push(event);
    if (job.events.length > 2000) job.events.splice(0, job.events.length - 2000);
    // Write-through to the durable log first so a crash between here and the
    // listener fan-out can never lose an event. Best-effort: storage must never
    // break a running job.
    if (this.store) { try { this.store.appendEvent(job.id, job.tenantId, event); } catch { /* best effort */ } }
    for (const listener of job.listeners) {
      try { listener(event); } catch { /* a listener must never break the job */ }
    }
    return event;
  }

  /**
   * Start a creation job. Returns immediately with the job id + status.
   * @param {object} input
   * @param {string} input.goal
   * @param {string} [input.tenantId]
   * @param {string} [input.userId]
   * @param {object} [input.options]  director options (format/duration/resolution/fps/bundle/model/...).
   */
  start({ goal, tenantId = null, userId = null, options = {} } = {}) {
    this.#evict();
    // Bounded retention: prune old terminal jobs at most once a minute so the
    // durable registry cannot grow without limit. Best-effort and non-fatal.
    if (this.store && Date.now() - this.lastPruneAt > 60_000) {
      this.lastPruneAt = Date.now();
      try { this.store.prune(); } catch { /* best effort */ }
    }
    const id = `cre_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
      id,
      tenantId,
      userId,
      goal,
      options,
      status: 'running',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: [],
      listeners: new Set(),
      progress: { stage: 'queued', done: 0, total: 0 },
      result: null,
      error: null,
      artifacts: {},
      artifactMeta: {},
      controller: new AbortController(),
      startedAt: Date.now(),
      elapsedMs: 0,
    };
    this.jobs.set(id, job);
    // Persist the job row before the first event so a crash mid-start still
    // leaves a durable (interrupted) record rather than nothing at all.
    if (this.store) { try { this.store.saveJob(job); } catch { /* best effort */ } }
    this.#push(job, 'job.started', { goal, options });
    // Fire-and-forget: the run owns its own error handling and never rejects here.
    //
    // Defer the run to the NEXT macrotask instead of starting it inline. The
    // Director's early stages resolve deterministically (as microtasks) and the
    // render is CPU-heavy and synchronous, so calling `#run` here would keep this
    // call — and therefore the HTTP response that returns the job id — blocked on
    // the event loop for the entire render. Deferring makes `start()` truly
    // return immediately (as documented) and keeps the server responsive while
    // the job runs.
    setImmediate(() => { this.#run(job).catch(() => {}); });
    return this.view(job);
  }

  async #run(job) {
    try {
      // The studio owns the run's control plane. A caller must never be able to
      // replace the internal AbortSignal (cancellation) or the internal onEvent
      // sink (progress + event tracking) by smuggling `signal`/`onEvent` into
      // `options`. They are stripped here and re-applied LAST so the internal
      // ones are always authoritative, regardless of spread order.
      const { signal: _userSignal, onEvent: _userOnEvent, ...userOptions } = job.options || {};
      const result = await runDirector(job.goal, {
        ...userOptions,
        llm: this.llm,
        providers: this.providers,
        signal: job.controller.signal,
        onEvent: (type, payload) => {
          if (type === 'render_progress') {
            job.progress = { stage: 'render', done: payload.done || 0, total: payload.total || 0 };
          } else if (type === 'stage') {
            job.progress = { ...job.progress, stage: payload.stage };
          }
          this.#push(job, type, payload);
        },
      });
      job.status = 'completed';
      job.result = {
        brief: result.brief,
        storyboard: result.storyboard,
        bibles: result.bibles,
        timeline: result.timeline,
        critique: result.critique,
        iterations: result.iterations.map((i) => ({ iteration: i.iteration, score: i.score, subscores: i.critique.subscores })),
        manifest: result.manifest,
        assets: result.assets,
      };
      job.artifacts = {
        gif: result.media.gif || null,
        avi: result.media.avi || null,
        bundle: result.media.bundle || null,
        mp4: result.media.mp4 || null,
      };
      job.elapsedMs = Date.now() - job.startedAt;
      this.#push(job, 'job.completed', { manifest: result.manifest, elapsedMs: job.elapsedMs });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = message === 'CREATION_CANCELLED' ? 'cancelled' : 'failed';
      job.error = message;
      job.elapsedMs = Date.now() - job.startedAt;
      this.#push(job, job.status === 'cancelled' ? 'job.cancelled' : 'job.failed', { error: message });
    } finally {
      job.updatedAt = nowIso();
      job.controller = null;
      // Durable write-through of the terminal state: the job row (status, result
      // manifest, error) and the artifact bytes. Done here so BOTH success and
      // failure are persisted exactly once, and best-effort so a storage error
      // never masks the real job outcome.
      if (this.store) {
        try { this.store.saveJob(job); } catch { /* best effort */ }
        try { this.store.saveArtifacts(job.id, job.tenantId, job.artifacts); } catch { /* best effort */ }
      }
    }
  }

  /**
   * Resolve a job for a caller, enforcing tenant isolation fail-closed.
   *
   * A job is returned ONLY when the caller's tenant matches the job's tenant
   * EXACTLY. This means:
   *   - a tenant-scoped caller can never read another tenant's job;
   *   - a tenant-scoped caller can never read an unowned/system job (one created
   *     with no tenant), and
   *   - a caller with no tenant can never read a tenant-owned job.
   * Anything else resolves to `null`, which the routes turn into an honest 404,
   * so an id belonging to another tenant is indistinguishable from a missing id.
   */
  #owned(job, tenantId) {
    if (!job) return null;
    return (job.tenantId ?? null) === (tenantId ?? null) ? job : null;
  }

  get(id, tenantId = null) {
    return this.#owned(this.jobs.get(id), tenantId);
  }

  view(job) {
    if (!job) return null;
    return {
      id: job.id,
      goal: job.goal,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      elapsedMs: job.elapsedMs,
      progress: job.progress,
      error: job.error,
      result: job.result,
      artifacts: {
        gif: this.#artifactView(job, 'gif', 'image/gif'),
        avi: this.#artifactView(job, 'avi', 'video/x-msvideo'),
        bundle: this.#artifactView(job, 'bundle', 'application/zip'),
        mp4: this.#artifactView(job, 'mp4', 'video/mp4'),
      },
    };
  }

  // A fresh (in-process) job reports the live buffer length; a job rehydrated
  // from durable storage reports the persisted byte count. Both are honest.
  #artifactView(job, name, mimeType) {
    const buffer = job.artifacts?.[name];
    if (buffer) return { bytes: buffer.length, mimeType };
    const meta = job.artifactMeta?.[name];
    if (meta && Number(meta.bytes) > 0) return { bytes: meta.bytes, mimeType: meta.mimeType || mimeType };
    return null;
  }

  status(id, tenantId = null) {
    return this.view(this.get(id, tenantId));
  }

  list(tenantId = null, limit = 50) {
    // Same fail-closed rule as get(): a caller only ever sees jobs that belong
    // to its OWN tenant. Unowned/system jobs and other tenants' jobs are never
    // leaked into a tenant's listing.
    return [...this.jobs.values()]
      .filter((job) => (job.tenantId ?? null) === (tenantId ?? null))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((job) => this.view(job));
  }

  artifact(id, name, tenantId = null) {
    const job = this.get(id, tenantId);
    if (!job) return null;
    let buffer = job.artifacts[name];
    let mimeType = name === 'gif' ? 'image/gif' : name === 'avi' ? 'video/x-msvideo' : name === 'bundle' ? 'application/zip' : name === 'mp4' ? 'video/mp4' : 'application/octet-stream';
    // A rehydrated job has no live buffer; read the persisted bytes back. This is
    // what makes a completed deliverable downloadable after a restart.
    if (!buffer && this.store) {
      try {
        const stored = this.store.loadArtifact(job.id, name);
        if (stored) { buffer = stored.buffer; mimeType = stored.mimeType || mimeType; }
      } catch { /* best effort */ }
    }
    if (!buffer) return null;
    return { buffer, mimeType, filename: `semo0o-${job.id}.${name === 'bundle' ? 'zip' : name}` };
  }

  events(id, tenantId = null, sinceSeq = 0) {
    const job = this.get(id, tenantId);
    if (!job) return null;
    return { job, events: job.events.filter((e) => e.seq > sinceSeq) };
  }

  subscribe(id, listener, tenantId = null) {
    const job = this.get(id, tenantId);
    if (!job) return null;
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  cancel(id, tenantId = null) {
    const job = this.get(id, tenantId);
    if (!job) return null;
    if (TERMINAL.has(job.status)) return this.view(job);
    try { job.controller?.abort(); } catch { /* ignore */ }
    return this.view(job);
  }

  /** Fast, synchronous plan (brief + storyboard + bibles + prompts). */
  async plan(goal, options = {}) {
    // The studio's own llm/providers are authoritative and cannot be swapped in
    // via caller options (the HTTP whitelist already drops them; this is defense
    // in depth for direct API callers). A caller-supplied `signal` is still
    // honoured — it only aborts the caller's own plan request.
    const result = await planCreation(goal, { ...options, llm: this.llm, providers: this.providers });
    return result;
  }
}

export { TERMINAL as CREATION_TERMINAL_STATES };
