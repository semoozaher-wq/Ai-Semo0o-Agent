// Creation Studio — the async job layer behind the /creation/* API.
//
// The Director is a long, stateful process (think → plan → render → critique →
// improve → deliver). This module turns it into a first-class, observable job:
// start it, stream its events, poll its status, download its artefacts, cancel
// it. It is deliberately transport-agnostic (no HTTP here) so it can be unit
// tested and reused by the queue, a CLI or a worker.
//
// Jobs are kept in a bounded, TTL-evicted in-memory registry. That is honest for
// a single-node deployment; the artefact bytes are what matter and they are also
// written into the workspace by the studio.* tools. A durable store can be
// dropped in behind the same interface without touching the routes.

import { runDirector, planCreation } from './director.mjs';
import { createCreationProviders } from './providers.mjs';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {object} [options]
 * @param {object} [options.llm]      server LLM router (optional; deterministic fallback is used when absent).
 * @param {object} [options.providers] pre-built CreationProviders (optional).
 * @param {number} [options.maxJobs]  bounded registry size (default 40).
 * @param {number} [options.ttlMs]    eviction age for terminal jobs (default 1h).
 */
export class CreationStudio {
  constructor({ llm = null, providers = null, maxJobs = 40, ttlMs = 60 * 60 * 1000, env = process.env } = {}) {
    this.llm = llm;
    this.providers = providers || createCreationProviders(env);
    this.maxJobs = Math.max(1, maxJobs);
    this.ttlMs = Math.max(60_000, ttlMs);
    this.jobs = new Map();
    this.seq = 0;
  }

  capabilities() {
    return {
      kernel: true,
      localStudio: true,
      providers: this.providers.capabilities,
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
      controller: new AbortController(),
      startedAt: Date.now(),
      elapsedMs: 0,
    };
    this.jobs.set(id, job);
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
        gif: job.artifacts.gif ? { bytes: job.artifacts.gif.length, mimeType: 'image/gif' } : null,
        avi: job.artifacts.avi ? { bytes: job.artifacts.avi.length, mimeType: 'video/x-msvideo' } : null,
        bundle: job.artifacts.bundle ? { bytes: job.artifacts.bundle.length, mimeType: 'application/zip' } : null,
      },
    };
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
    const buffer = job.artifacts[name];
    if (!buffer) return null;
    const mimeType = name === 'gif' ? 'image/gif' : name === 'avi' ? 'video/x-msvideo' : name === 'bundle' ? 'application/zip' : 'application/octet-stream';
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
