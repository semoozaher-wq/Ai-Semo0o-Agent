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
    this.#run(job).catch(() => {});
    return this.view(job);
  }

  async #run(job) {
    try {
      const result = await runDirector(job.goal, {
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
        ...job.options,
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

  get(id, tenantId = null) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (tenantId && job.tenantId && job.tenantId !== tenantId) return null;
    return job;
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
    return [...this.jobs.values()]
      .filter((job) => !tenantId || !job.tenantId || job.tenantId === tenantId)
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
    const result = await planCreation(goal, { llm: this.llm, providers: this.providers, ...options });
    return result;
  }
}

export { TERMINAL as CREATION_TERMINAL_STATES };
