// =============================================================================
// backend/agent/evaluation.mjs
// -----------------------------------------------------------------------------
// A reusable evaluation & quality-control layer for REAL agent runs.
//
// Everything here is derived from the durable rows a run already writes
// (`runs`, `tool_calls`, `evidence`, `run_usage`, `approvals`, `run_events`), so
// the numbers are reproducible and never approximated or invented. It does NOT
// add a second observability system: it is a scoring/aggregation layer that the
// existing observability endpoint (`backend/observability/metrics.mjs`) and the
// HTTP API consume additively.
//
// What it scores, per run:
//   - outcome / success        (terminal status -> success score)
//   - tool-use efficiency      (success ratio + replan/loop penalties)
//   - latency & cost           (wall-clock from run timestamps + run_usage)
//   - evidence completeness    (verified vs unverified verification evidence)
//   - human intervention       (approvals requested/decided/pending)
//   - a composite quality score (0..100)
//
// It also exposes:
//   - `evaluateRuns`  : windowed aggregate across many runs (a real scorecard);
//   - `compareRuns`   : a regression hook that compares two runs and flags a
//                       quality regression beyond a threshold.
//
// All functions are pure reads and fail-soft: a malformed row can never throw.
// =============================================================================

import { now } from '../db/client.mjs';

// Kept local (not imported from metrics.mjs) so the observability layer can
// depend on this module without a circular import.
export const SUCCESS_STATES = Object.freeze(['completed', 'completed_with_warnings']);
export const TERMINAL_STATES = Object.freeze(['completed', 'completed_with_warnings', 'failed', 'cancelled', 'unverified', 'blocked']);
const SUCCESS = new Set(SUCCESS_STATES);

// Terminal status -> outcome score. `completed` is a clean success; a warning or
// unverified outcome is a partial success; a block/cancel is near-zero; a hard
// failure is zero.
export const OUTCOME_SCORES = Object.freeze({
  completed: 1,
  completed_with_warnings: 0.7,
  unverified: 0.5,
  blocked: 0.2,
  cancelled: 0.1,
  failed: 0,
});

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const round = (value, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
};

function parseJsonSafe(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * Compose the 0..100 composite quality score from the individual signals. Pure
 * so it can be unit-tested without a database.
 */
export function composeQualityScore({ successScore = 0, evidenceCompleteness = 0, toolSuccessRatio = 1, interventionRequired = false, replans = 0, loopDetected = false } = {}) {
  const success = clamp01(successScore) * 50;
  const evidence = clamp01(evidenceCompleteness) * 20;
  const tools = clamp01(toolSuccessRatio) * 15;
  const autonomy = interventionRequired ? 0 : 10;
  const discipline = Math.max(0, 5 - Math.max(0, Number(replans) || 0) * 2.5 - (loopDetected ? 5 : 0));
  return round(Math.max(0, Math.min(100, success + evidence + tools + autonomy + discipline)), 2);
}

/**
 * Evaluate a single run from its durable rows. Returns null when the run does
 * not exist (or is not visible to `tenantId`). Never throws.
 */
export function evaluateRun(db, runId, { tenantId, statusOverride = null } = {}) {
  if (!db || !runId) return null;
  let run;
  try {
    run = tenantId
      ? db.get('SELECT * FROM runs WHERE id=? AND tenant_id=?', runId, tenantId)
      : db.get('SELECT * FROM runs WHERE id=?', runId);
  } catch { return null; }
  if (!run) return null;
  // The learning loop scores a run the instant it reaches a terminal state, which
  // is BEFORE the queue persists that state onto `runs` (the handler still sees
  // `status='running'`). Callers that already KNOW the authoritative terminal
  // status pass it here so the outcome/reward is scored from the real status
  // instead of the stale row. Only a genuine terminal status is honoured; any
  // other value falls back to the persisted row (fully backward compatible).
  const effectiveStatus = (statusOverride && TERMINAL_STATES.includes(statusOverride)) ? statusOverride : run.status;

  const tools = db.all('SELECT status FROM tool_calls WHERE run_id=?', runId);
  const evidence = db.all('SELECT kind,payload_json FROM evidence WHERE run_id=?', runId);
  const approvals = db.all('SELECT decision FROM approvals WHERE run_id=?', runId);
  const events = db.all('SELECT type,payload_json FROM run_events WHERE run_id=?', runId);
  const usage = db.get('SELECT COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS n FROM run_usage WHERE run_id=?', runId);

  const totalCalls = tools.length;
  const failedCalls = tools.filter((row) => row.status === 'failed').length;
  const toolSuccessRatio = totalCalls ? (totalCalls - failedCalls) / totalCalls : 1;

  let replans = 0;
  let loopDetected = false;
  for (const row of events) {
    const payload = parseJsonSafe(row.payload_json, {});
    if ((row.type === 'self_healing' && payload.action === 'replan') || row.type === 'replanned' || row.type === 'multi_agent_replanned') replans += 1;
    if (row.type === 'run_finished' && /LOOP_DETECTED/.test(JSON.stringify(payload))) loopDetected = true;
  }

  let verifiedSteps = 0;
  let unverifiedSteps = 0;
  for (const row of evidence) {
    if (row.kind !== 'verification') continue;
    const payload = parseJsonSafe(row.payload_json, {});
    if (payload.status === 'VERIFIED') verifiedSteps += 1;
    else if (payload.status === 'UNVERIFIED') unverifiedSteps += 1;
  }
  const totalChecks = verifiedSteps + unverifiedSteps;
  let evidenceCompleteness;
  if (totalChecks > 0) evidenceCompleteness = verifiedSteps / totalChecks;
  else if (totalCalls > 0) evidenceCompleteness = toolSuccessRatio;
  else evidenceCompleteness = SUCCESS.has(effectiveStatus) ? 1 : 0;

  const success = SUCCESS.has(effectiveStatus);
  const successScore = OUTCOME_SCORES[effectiveStatus] ?? 0.5;
  const tokens = Number(usage?.tokens) || 0;
  const costUsd = Number(usage?.cost) || 0;
  const created = Date.parse(run.created_at);
  const updated = Date.parse(run.updated_at);
  const latencyMs = Number.isFinite(created) && Number.isFinite(updated) ? Math.max(0, updated - created) : null;

  const approvalsRequested = approvals.length;
  const approvalsPending = approvals.filter((row) => row.decision === 'pending').length;
  const approvalsDecided = approvals.filter((row) => row.decision === 'allow' || row.decision === 'deny').length;
  const interventionRequired = approvalsRequested > 0;

  const qualityScore = composeQualityScore({ successScore, evidenceCompleteness, toolSuccessRatio, interventionRequired, replans, loopDetected });

  return {
    runId: run.id,
    tenantId: run.tenant_id,
    taskId: run.task_id,
    status: effectiveStatus,
    success,
    outcome: { status: effectiveStatus, success, successScore: round(successScore) },
    toolUse: { totalCalls, failedCalls, successRatio: round(toolSuccessRatio), replans, loopDetected },
    cost: { tokens, costUsd: round(costUsd, 6), latencyMs, costPerSuccess: success ? round(costUsd, 6) : null },
    verification: { evidenceCount: evidence.length, verifiedSteps, unverifiedSteps, completeness: round(evidenceCompleteness) },
    humanIntervention: { approvalsRequested, approvalsPending, approvalsDecided, required: interventionRequired },
    qualityScore,
    evaluatedAt: now(),
  };
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return round(usable.reduce((total, value) => total + value, 0) / usable.length);
}

/**
 * Windowed aggregate scorecard across many runs. When `projectId` is given the
 * runs are restricted to that project (joined through `tasks`). Returns a real,
 * reproducible summary suitable for a dashboard or a regression gate.
 */
export function evaluateRuns(db, { tenantId, projectId, windowHours = 24 * 7, limit = 500, now: nowFn = () => new Date() } = {}) {
  if (!db) return { count: 0, runs: [] };
  const since = new Date(nowFn().getTime() - Math.max(1, Number(windowHours) || 168) * 3_600_000).toISOString();
  const placeholders = TERMINAL_STATES.map(() => '?').join(',');
  let rows;
  try {
    rows = projectId
      ? db.all(`SELECT r.id FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.tenant_id=? AND t.project_id=? AND r.status IN (${placeholders}) AND r.created_at>=? ORDER BY r.created_at DESC LIMIT ?`, tenantId, projectId, ...TERMINAL_STATES, since, Math.min(5000, Math.max(1, limit)))
      : db.all(`SELECT r.id FROM runs r WHERE r.tenant_id=? AND r.status IN (${placeholders}) AND r.created_at>=? ORDER BY r.created_at DESC LIMIT ?`, tenantId, ...TERMINAL_STATES, since, Math.min(5000, Math.max(1, limit)));
  } catch { rows = []; }

  const evaluations = rows.map((row) => evaluateRun(db, row.id, { tenantId })).filter(Boolean);
  const byStatus = {};
  for (const evaluation of evaluations) byStatus[evaluation.status] = (byStatus[evaluation.status] ?? 0) + 1;
  const successes = evaluations.filter((evaluation) => evaluation.success).length;
  const interventionRuns = evaluations.filter((evaluation) => evaluation.humanIntervention.required).length;
  const totalCostUsd = round(evaluations.reduce((total, evaluation) => total + evaluation.cost.costUsd, 0), 6);
  const costPerSuccess = successes ? round(totalCostUsd / successes, 6) : null;

  return {
    windowHours: Math.max(1, Number(windowHours) || 168),
    generatedAt: nowFn().toISOString(),
    count: evaluations.length,
    byStatus,
    successRatio: evaluations.length ? round(successes / evaluations.length) : null,
    avgQualityScore: average(evaluations.map((evaluation) => evaluation.qualityScore)),
    avgToolEfficiency: average(evaluations.map((evaluation) => evaluation.toolUse.successRatio)),
    avgEvidenceCompleteness: average(evaluations.map((evaluation) => evaluation.verification.completeness)),
    interventionRate: evaluations.length ? round(interventionRuns / evaluations.length) : null,
    totalCostUsd,
    costPerSuccess,
    avgLatencyMs: average(evaluations.map((evaluation) => evaluation.cost.latencyMs)),
    runs: evaluations,
  };
}

/**
 * Regression / comparison hook: compare a candidate run against a baseline run
 * and report the deltas plus a boolean regression flag when the candidate's
 * composite quality drops by more than `threshold` points.
 */
export function compareRuns(db, baselineRunId, candidateRunId, { tenantId, threshold = 5 } = {}) {
  const baseline = evaluateRun(db, baselineRunId, { tenantId });
  const candidate = evaluateRun(db, candidateRunId, { tenantId });
  if (!baseline || !candidate) return null;
  const delta = (a, b) => round(b - a);
  const qualityDelta = delta(baseline.qualityScore, candidate.qualityScore);
  return {
    baseline: { runId: baseline.runId, status: baseline.status, qualityScore: baseline.qualityScore },
    candidate: { runId: candidate.runId, status: candidate.status, qualityScore: candidate.qualityScore },
    deltas: {
      qualityScore: qualityDelta,
      successScore: delta(baseline.outcome.successScore, candidate.outcome.successScore),
      toolEfficiency: delta(baseline.toolUse.successRatio, candidate.toolUse.successRatio),
      evidenceCompleteness: delta(baseline.verification.completeness, candidate.verification.completeness),
      costUsd: delta(baseline.cost.costUsd, candidate.cost.costUsd),
      latencyMs: Number.isFinite(baseline.cost.latencyMs) && Number.isFinite(candidate.cost.latencyMs) ? delta(baseline.cost.latencyMs, candidate.cost.latencyMs) : null,
    },
    threshold,
    regression: qualityDelta < -Math.abs(Number(threshold) || 5),
    improved: qualityDelta > Math.abs(Number(threshold) || 5),
  };
}
