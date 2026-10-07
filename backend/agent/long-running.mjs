/**
 * backend/agent/long-running.mjs — Long-Running Autonomous Execution.
 *
 * The agent runtime enforces hard, per-run caps (wall-clock timeout, step and
 * tool-call budgets). Those caps exist for safety and must not be removed. This
 * supervisor lets a run that hits a *bounded* limit continue instead of failing:
 * the runtime checkpoints `{plan, stepIndex}` (it already does this) and returns
 * `status: 'continuation'`; the supervisor then enqueues a NEW run on the SAME
 * task that resumes from that checkpoint (`payload.resumeFrom`).
 *
 * It composes the existing pieces — the RunQueue (enqueue) and the run's
 * `checkpoint_json` — and adds no new execution engine and no new sandboxing.
 * Continuations are bounded by `maxContinuations` so a run can never loop
 * forever; when the bound is reached the run is reported as a terminal,
 * retryable `completed_with_warnings` instead of a non-terminal `continuation`.
 */

// Only a *resumable* bound qualifies. The wall-clock budget can be exhausted
// mid-plan, and the run has a durable checkpoint to resume from. Structural caps
// (AGENT_STEP_LIMIT_EXCEEDED, AGENT_TOOL_CALL_LIMIT_EXCEEDED, AGENT_LOOP_DETECTED)
// are thrown before/around a step and would simply re-trip on a fresh run, so
// they stay hard failures instead of looping.
const BOUNDED_LIMIT_ERRORS = new Set(['AGENT_TIME_LIMIT_EXCEEDED']);

function safeParse(json) {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Read the durable `{plan, stepIndex}` checkpoint the runtime persists. */
export function parseCheckpoint(checkpointJson) {
  const parsed = safeParse(checkpointJson);
  if (!parsed) return null;
  const raw = Number(parsed.stepIndex ?? 0);
  return {
    plan: parsed.plan ?? null,
    stepIndex: Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0,
  };
}

/** True when a thrown error is a bounded limit that a continuation can resume from. */
export function isBoundedLimitError(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return BOUNDED_LIMIT_ERRORS.has(message);
}

export class ContinuationSupervisor {
  constructor({ db, queue, maxContinuations = Number(process.env.AGENT_MAX_CONTINUATIONS || 5), onScheduled } = {}) {
    if (!db) throw new Error('DB_REQUIRED');
    if (!queue || typeof queue.enqueue !== 'function') throw new Error('QUEUE_REQUIRED');
    this.db = db;
    this.queue = queue;
    this.maxContinuations = Math.max(0, Math.floor(Number(maxContinuations) || 0));
    this.onScheduled = typeof onScheduled === 'function' ? onScheduled : null;
  }

  /** How many continuations this run has already spawned. */
  continuationsFor(run) {
    const payload = safeParse(run?.payload_json);
    return Math.max(0, Number(payload?.continuations ?? 0));
  }

  /** Decide whether a finished run should be continued. */
  shouldContinue(run, result) {
    if (!result || result.status !== 'continuation') return false;
    if (this.continuationsFor(run) >= this.maxContinuations) return false;
    return parseCheckpoint(run?.checkpoint_json) !== null;
  }

  /** Enqueue the continuation run that resumes from the run's checkpoint. */
  async continue(run, result) {
    const checkpoint = parseCheckpoint(run.checkpoint_json) ?? { plan: null, stepIndex: 0 };
    const payload = safeParse(run.payload_json) ?? {};
    const continuations = this.continuationsFor(run) + 1;
    const nextPayload = {
      ...payload,
      resumeFrom: checkpoint.stepIndex,
      continuations,
      parentRunId: run.id,
      continuationReason: result?.reason ?? 'bounded_limit',
    };
    const next = this.queue.enqueue({
      taskId: run.task_id,
      tenantId: run.tenant_id,
      payload: nextPayload,
      kind: payload.kind ?? 'agent.run',
      idempotencyKey: null,
    });
    if (this.onScheduled) this.onScheduled({ run, next, checkpoint, continuations });
    return next;
  }

  /**
   * Wrap an agent handler so a bounded stop transparently schedules a
   * continuation. A supervisor failure must never turn a finished run into a
   * failure, so every supervisor error is reported in the result, not thrown.
   */
  wrap(handler) {
    if (typeof handler !== 'function') throw new Error('HANDLER_REQUIRED');
    return async (input) => {
      const result = await handler(input);
      if (!result || result.status !== 'continuation') return result;
      // `continuation` is a transient signal, never a persisted terminal state:
      // the run is reported as a terminal `completed_with_warnings` (retryable)
      // and the `continuation` field records what was scheduled. This keeps the
      // SSE stream and the queue state machine terminating correctly.
      try {
        // Re-read the run: the handler just wrote the fresh checkpoint, so the
        // snapshot handed to the handler may be stale.
        const fresh = this.db.get('SELECT * FROM runs WHERE id=?', input.run?.id) ?? input.run;
        if (this.shouldContinue(fresh, result)) {
          const next = await this.continue(fresh, result);
          return { ...result, status: 'completed_with_warnings', continuation: { scheduled: true, runId: next?.id ?? null, continuations: this.continuationsFor(fresh) + 1 } };
        }
        return { ...result, status: 'completed_with_warnings', continuation: { scheduled: false, reason: 'continuation_limit_reached', limit: this.maxContinuations } };
      } catch (error) {
        return { ...result, status: 'completed_with_warnings', continuation: { scheduled: false, reason: 'supervisor_error', error: error instanceof Error ? error.message : String(error) } };
      }
    };
  }
}

export function createContinuationSupervisor(options) {
  return new ContinuationSupervisor(options);
}
