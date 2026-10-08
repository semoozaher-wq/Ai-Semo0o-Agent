// =============================================================================
// backend/agent/learning-loop.mjs
// -----------------------------------------------------------------------------
// ONE cohesive learning loop for Semo0o.
//
// Before this module the five learning components existed but were only loosely
// coupled, and two of the links were missing entirely:
//
//   * Evaluation (agent/evaluation.mjs) produced a GRADED quality score per run
//     that was never fed back into anything.
//   * Self-improve (self-improve/*) could only be triggered MANUALLY over HTTP.
//
// This module is the single place that closes the loop. After a run reaches a
// terminal state it runs, in order and fail-soft:
//
//   1. EVALUATE  — score the run (graded outcome + 0..100 quality).
//   2. REFLECT   — distil bounded lessons and persist them WITH the graded score
//                  (so the reflection is the durable join between the layers).
//   3. CONSOLIDATE — fold recurring lessons into one reusable project knowledge
//                  document (memory).
//   4. EXPERIENCE — the graded score is now readable by the Experience Engine's
//                  next snapshot (the caller invalidates its cache).
//   5. SELF-IMPROVE — a bounded, rate-limited pass that creates PROPOSALS for
//                  review and auto-rolls-back regressions (never auto-applies).
//
// Everything is additive, bounded and fail-soft: a failure in any stage can never
// change or break the run it is learning from, and with self-improve disabled the
// loop degrades to exactly the previous evaluate+reflect+consolidate behaviour.
// =============================================================================

import { evaluateRun, evaluateRuns, TERMINAL_STATES } from './evaluation.mjs';
import { reflectOnRun, listReflections } from './reflection.mjs';
import { buildExperienceSnapshot, summarizeExperience } from './experience.mjs';
import { consolidateProjectMemory } from '../memory/consolidate.mjs';
import { analyze as selfImproveAnalyze, monitor as selfImproveMonitor } from '../self-improve/engine.mjs';
import { listProposals } from '../self-improve/store.mjs';

export const LEARNING_LOOP_VERSION = 1;

const TERMINAL = new Set(TERMINAL_STATES);

// The async self-improve pass runs at most once per tenant per interval so a
// burst of runs cannot repeatedly re-scan the same telemetry. Bounded + safe
// (proposals require human approval; only regressions auto-roll-back).
export const SELF_IMPROVE_MIN_INTERVAL_MS = Math.max(0, Number(process.env.AGENT_SELF_IMPROVE_INTERVAL_MS ?? 60_000));
const lastSelfImprove = new Map();

/** Reset the in-process rate-limit state (used by tests). */
export function resetLearningLoopState() {
  lastSelfImprove.clear();
}

/**
 * SYNCHRONOUS core of the loop: evaluate a terminal run, then persist a
 * reflection that carries the graded quality/reward. Runs inline (no await) so
 * it preserves the exact timing of the previous `reflectOnRun` call. Never
 * throws for expected conditions.
 */
export function finalizeRunLearning({ db, run, result = {}, events = [], status = null } = {}) {
  if (!db || !run) return null;
  // The authoritative terminal status: prefer the caller's explicit status, then
  // the result's status, then the persisted row. This is essential because the
  // runtime finalizes learning BEFORE the queue writes the terminal status, so
  // `runs.status` can still read 'running' at this point. Passing the real status
  // through makes the graded reward correct instead of defaulting to 0.5.
  const authoritativeStatus = status ?? result?.status ?? null;
  // If the caller told us the run's status and it is NOT terminal yet (e.g. a
  // 'continuation' handoff, which leaves the run outstanding), there is nothing
  // terminal to learn from — skip so we never record a bogus reward for work
  // that is still in flight. A null status (unknown) still proceeds and falls
  // back to the persisted row.
  if (authoritativeStatus && !TERMINAL.has(authoritativeStatus)) return null;
  let evaluation = null;
  try { evaluation = evaluateRun(db, run.id, { tenantId: run.tenant_id, statusOverride: authoritativeStatus }); } catch { evaluation = null; }
  const quality = evaluation?.qualityScore ?? null;
  const reward = evaluation?.outcome?.successScore ?? null;
  let reflection = null;
  try { reflection = reflectOnRun({ db, run, result, events, quality, reward }); } catch { reflection = null; }
  return {
    runId: run.id,
    status: evaluation?.status ?? authoritativeStatus ?? run.status ?? null,
    qualityScore: quality,
    reward,
    success: evaluation?.success ?? null,
    reflectionId: reflection?.id ?? null,
    lessons: reflection?.lessons?.length ?? 0,
  };
}

/**
 * The full asynchronous cycle. Calls `finalizeRunLearning` first (synchronously,
 * so the reflection is durable before the first await), then memory
 * consolidation and the bounded self-improve pass. Returns the combined summary
 * or null when there is nothing to learn from.
 */
export async function runLearningCycle({ db, memory = null, run, result = {}, events = [], projectId = null, selfImprove = {}, now = () => Date.now(), finalize = true, status = null } = {}) {
  if (!db || !run) return null;
  // `finalize: false` lets a caller that has ALREADY run the synchronous
  // `finalizeRunLearning` (e.g. the runtime, which must persist the reflection
  // before the handler returns) run only the async remainder without a duplicate
  // evaluation/reflection.
  const base = finalize ? finalizeRunLearning({ db, run, result, events, status }) : { runId: run.id };
  if (!base) return null;
  const tenantId = run.tenant_id;
  const pid = projectId || run.project_id || null;

  // 1) Memory consolidation: episodic lessons -> reusable project knowledge.
  let consolidated = null;
  if (memory && pid) {
    try { consolidated = await consolidateProjectMemory({ db, memory, tenantId, projectId: pid }); }
    catch { consolidated = null; }
  }

  // 2) Self-improve: bounded + rate-limited. Creates PROPOSALS only (human
  //    approval required before apply) and auto-rolls-back regressions.
  const selfImproveEnabled = selfImprove.enabled ?? (process.env.AGENT_SELF_IMPROVE_AUTO !== 'false');
  let selfImproveResult = null;
  if (selfImproveEnabled && tenantId) {
    const interval = Math.max(0, Number(selfImprove.intervalMs ?? SELF_IMPROVE_MIN_INTERVAL_MS));
    const last = lastSelfImprove.get(tenantId) ?? 0;
    if (now() - last >= interval) {
      lastSelfImprove.set(tenantId, now());
      try {
        const monitored = selfImproveMonitor(db, { tenantId, windowHours: selfImprove.windowHours ?? 24 });
        const analyzed = selfImproveAnalyze(db, {
          tenantId,
          windowHours: selfImprove.windowHours ?? 168,
          minOccurrences: selfImprove.minOccurrences ?? 2,
          autoCreate: true,
          createdBy: 'learning-loop',
        });
        selfImproveResult = { rolledBack: monitored.rolledBack.length, signals: analyzed.signals.length, proposals: analyzed.proposals.length };
      } catch { selfImproveResult = null; }
    } else {
      selfImproveResult = { skipped: 'rate_limited' };
    }
  }

  return {
    version: LEARNING_LOOP_VERSION,
    runId: run.id,
    ...base,
    consolidated: consolidated ? { kept: consolidated.kept, written: consolidated.written } : null,
    selfImprove: selfImproveResult,
  };
}

/**
 * A read-only view of the WHOLE loop for one tenant, so an operator (or the API)
 * can see all five components side by side: the evaluation scorecard, the
 * experience snapshot summary, the open self-improve proposals and the latest
 * reflections. Pure reads; fail-soft.
 */
export function learningSummary({ db, tenantId, projectId = null, windowHours = 24 * 7, now = () => new Date() } = {}) {
  if (!db || !tenantId) return { available: false };
  const evaluation = (() => { try { return evaluateRuns(db, { tenantId, projectId, windowHours, now }); } catch { return null; } })();
  const snapshot = (() => { try { return buildExperienceSnapshot(db, { tenantId, windowHours: Math.max(windowHours, 24 * 30) }); } catch { return null; } })();
  const proposals = (() => { try { return listProposals(db, tenantId, { status: 'proposed', limit: 20 }); } catch { return []; } })();
  const reflections = (() => { try { return listReflections(db, tenantId, { projectId, limit: 10 }); } catch { return []; } })();
  return {
    available: true,
    version: LEARNING_LOOP_VERSION,
    generatedAt: now().toISOString(),
    windowHours,
    evaluation: evaluation ? {
      count: evaluation.count,
      successRatio: evaluation.successRatio,
      avgQualityScore: evaluation.avgQualityScore,
      avgEvidenceCompleteness: evaluation.avgEvidenceCompleteness,
      interventionRate: evaluation.interventionRate,
      costPerSuccess: evaluation.costPerSuccess,
    } : null,
    experience: summarizeExperience(snapshot),
    selfImprove: { openProposals: proposals.length, proposals: proposals.map((p) => ({ id: p.id, kind: p.kind, title: p.title, severity: p.severity, occurrences: p.occurrences })) },
    reflections: reflections.map((r) => ({ runId: r.runId, status: r.status, qualityScore: r.qualityScore, reward: r.reward, lessons: r.lessons.length, createdAt: r.createdAt })),
  };
}
