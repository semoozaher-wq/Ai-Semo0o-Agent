// =============================================================================
// backend/agent/experience.mjs
// -----------------------------------------------------------------------------
// The Experience Engine — closes Semo0o's learning loop.
//
// The Maestro loop already *records* everything a run did (runs, run_usage,
// tool_calls, run_events, agent_reflections) and already *evaluates* each run
// (backend/agent/evaluation.mjs). What it did NOT do is feed that accumulated,
// real-world evidence back into its own decisions.
//
// v1 fed evidence back into ONE decision: model + tool selection (adaptive
// routing). v2 (this file) raises the ceiling: the SAME evidence now also
// informs the run's STRATEGY, its PLAN/EXECUTION METHOD and its RECOVERY, and
// every prior is derived through a single, robust, recency-aware estimator so
// the engine can never be fooled by thin, stale or lucky evidence.
//
// It turns durable rows into a per-tenant scorecard with five prior families:
//
//   1. `models`     — per (taskType, model) success/cost/latency  -> routing.
//   2. `tools`      — per tool success rate                       -> planning.
//   3. `recovery`   — per (failureKind, recoveryAction) success   -> recovery.
//   4. `strategies` — per (taskType, strategy) success            -> strategy.
//   5. `execution`  — per (taskType, tool) success                -> execution.
//
// Design rules (same as the rest of the agent layer):
//   * Pure reads, deterministic, fail-soft: a malformed row can never throw and
//     a missing table yields an empty snapshot (never a crash).
//   * Bayesian smoothing + a confidence gate for the v1 priors (so the static
//     policy stays the prior until there is enough real evidence) AND a
//     recency-weighted Wilson lower bound for the v2 priors.
//   * Tenant-scoped: a snapshot is always built for one tenant, so one tenant's
//     history can never influence another's decisions.
//
// DATA-QUALITY PROTECTIONS (the "never learn from weak/misleading/stale data"
// requirement) — all applied by `weightedStats`:
//   * RECENCY WEIGHTING: every observation is weighted `0.5 ** (age / halfLife)`
//     so a 14-day-old success counts half as much as today's, and stale evidence
//     fades to nothing instead of dominating forever.
//   * EFFECTIVE-SAMPLE GATE: confidence is derived from the *effective* (decayed)
//     sample size, not the raw count, so a burst of old rows cannot fake evidence.
//   * WILSON LOWER BOUND: the score used for ranking is the 95% lower confidence
//     bound of the success rate, not the raw mean — a lucky 2/2 streak (0.5) can
//     never out-rank a proven 18/20 (0.72). This is the single strongest, cheapest,
//     deterministic robustness upgrade over a raw rate (no stochastic bandit noise).
//   * MINIMUM EVIDENCE: a cell below `MIN_OBSERVATIONS` effective samples has
//     confidence 0 and is ignored entirely.
//   * MARGIN GATE: a recommendation is only emitted when the winner beats the
//     runner-up by a real margin, so near-ties never flip a decision on noise.
// =============================================================================

import { SUCCESS_STATES, TERMINAL_STATES } from './evaluation.mjs';
import { SUPPORTED_MODELS } from '../models/catalog.mjs';
import { FAILURE_KINDS } from './recovery.mjs';

export const EXPERIENCE_VERSION = 2;
export const DEFAULT_EXPERIENCE_WINDOW_HOURS = 24 * 30; // 30 days
// Observations needed before a model/tool is treated as fully "known".
export const CONFIDENCE_SATURATION = 5;
// Below this many observations the confidence is 0, so noise never re-ranks.
export const MIN_OBSERVATIONS = 2;
// Bayesian smoothing prior: an unknown model starts at a neutral 0.5 success
// rate and needs real evidence to move away from it.
const PRIOR_RATE = 0.5;
const PRIOR_STRENGTH = 2;

// --- v2: recency + robustness ------------------------------------------------
// Half-life of an observation's weight. 14 days means today's evidence counts
// twice as much as evidence from two weeks ago; anything older than the window
// (30 days) is already filtered out before weighting.
export const DEFAULT_DECAY_HALF_LIFE_HOURS = Number(process.env.AGENT_EXPERIENCE_HALF_LIFE_HOURS ?? 24 * 14);
// z for a 95% one-sided Wilson lower bound.
export const WILSON_Z = 1.96;
// A recovery/strategy recommendation is only trusted above these gates.
export const RECOVERY_MIN_CONFIDENCE = 0.5;
export const RECOVERY_MIN_MARGIN = 0.15;
export const STRATEGY_MIN_CONFIDENCE = 0.6;
export const STRATEGY_MIN_MARGIN = 0.15;
export const EXECUTION_MIN_CONFIDENCE = 0.6;
// The recovery actions we learn the effectiveness of (block is a hard rule, not a
// learned choice, so it is never a candidate to *recommend*).
export const LEARNABLE_RECOVERY_ACTIONS = Object.freeze(['retry', 'repair', 'replan']);
// The two execution strategies a run can choose between.
export const STRATEGIES = Object.freeze(['single-agent', 'multi-agent']);

const SUCCESS = new Set(SUCCESS_STATES);
const KNOWN_MODELS = new Set(Object.keys(SUPPORTED_MODELS));
const KNOWN_FAILURE_KINDS = new Set(FAILURE_KINDS);

function parseJsonSafe(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}
function clamp01(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
function smoothedRate(successes, attempts) {
  return (successes + PRIOR_RATE * PRIOR_STRENGTH) / (attempts + PRIOR_STRENGTH);
}
function confidenceFor(attempts) {
  return attempts >= MIN_OBSERVATIONS ? clamp01(attempts / CONFIDENCE_SATURATION) : 0;
}

// --- v2 estimator primitives -------------------------------------------------

/** Exponential recency weight: 1 today, 0.5 after one half-life, →0 as it ages. */
export function decayWeight(ageMs, halfLifeHours = DEFAULT_DECAY_HALF_LIFE_HOURS) {
  const halfLifeMs = Math.max(1, Number(halfLifeHours) || DEFAULT_DECAY_HALF_LIFE_HOURS) * 3_600_000;
  const age = Math.max(0, Number(ageMs) || 0);
  return 0.5 ** (age / halfLifeMs);
}

/**
 * The 95% one-sided Wilson lower bound of a success rate. `successes` and `n`
 * may be fractional (recency-weighted effective counts). Returns 0 when there is
 * no evidence. This is a conservative estimator: it is pulled toward 0 by small
 * samples, so a lucky streak can never out-rank a proven track record.
 */
export function wilsonLowerBound(successes, n, z = WILSON_Z) {
  const nn = Number(n);
  if (!(nn > 0)) return 0;
  const p = Math.max(0, Math.min(1, Number(successes) / nn));
  const z2 = z * z;
  const denom = 1 + z2 / nn;
  const center = p + z2 / (2 * nn);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * nn)) / nn);
  return Math.max(0, (center - margin) / denom);
}

/**
 * The single, shared estimator every v2 prior is derived through. It applies
 * recency weighting, the effective-sample confidence gate and the Wilson lower
 * bound in one place, so the data-quality guarantees cannot be forgotten.
 */
export function weightedStats(observations = [], { halfLifeHours = DEFAULT_DECAY_HALF_LIFE_HOURS, nowMs = Date.now(), saturation = CONFIDENCE_SATURATION } = {}) {
  let nEff = 0;
  let sEff = 0;
  let rawSuccesses = 0;
  for (const obs of observations) {
    const atMs = Number(obs?.atMs);
    const ageMs = Number.isFinite(atMs) ? Math.max(0, nowMs - atMs) : 0;
    const w = decayWeight(ageMs, halfLifeHours);
    nEff += w;
    if (obs?.success) { sEff += w; rawSuccesses += 1; }
  }
  const attempts = observations.length;
  const pHat = nEff > 0 ? sEff / nEff : 0;
  const lower = wilsonLowerBound(sEff, nEff, WILSON_Z);
  const confidence = nEff >= MIN_OBSERVATIONS ? clamp01(nEff / saturation) : 0;
  return {
    attempts,
    successes: rawSuccesses,
    successRate: round(attempts ? rawSuccesses / attempts : 0),
    effectiveSamples: round(nEff, 3),
    decayedSuccessRate: round(pHat),
    wilsonLowerBound: round(lower),
    confidence: round(confidence),
  };
}

function emptySnapshot({ windowHours, tenantId, generatedAt }) {
  return {
    version: EXPERIENCE_VERSION,
    generatedAt,
    windowHours,
    tenantId: tenantId ?? null,
    sampleSize: { runs: 0, modelObservations: 0, toolCalls: 0, recoveryObservations: 0, strategyObservations: 0 },
    models: {},
    tools: {},
    recovery: {},
    strategies: {},
    execution: {},
  };
}

/** Merge an event payload with its nested `details` (details win). */
function payloadDetails(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return { ...payload, ...(payload.details && typeof payload.details === 'object' ? payload.details : {}) };
}

/**
 * Build a per-tenant experience snapshot from durable rows. Never throws; a
 * missing table or malformed payload degrades to an empty (but valid) snapshot.
 */
export function buildExperienceSnapshot(db, { tenantId, windowHours = DEFAULT_EXPERIENCE_WINDOW_HOURS, limit = 500, halfLifeHours = DEFAULT_DECAY_HALF_LIFE_HOURS, now: nowFn = () => new Date() } = {}) {
  const nowDate = nowFn();
  const nowMs = nowDate.getTime();
  const generatedAt = nowDate.toISOString();
  const boundedWindow = Math.max(1, Number(windowHours) || DEFAULT_EXPERIENCE_WINDOW_HOURS);
  if (!db || !tenantId) return emptySnapshot({ windowHours: boundedWindow, tenantId, generatedAt });
  const since = new Date(nowMs - boundedWindow * 3_600_000).toISOString();
  const maxRows = Math.min(5000, Math.max(1, Number(limit) || 500));
  const placeholders = TERMINAL_STATES.map(() => '?').join(',');

  // --- Runs + their routing decision (task type) --------------------------
  let runRows = [];
  try {
    runRows = db.all(
      `SELECT r.id AS run_id, r.status AS status, r.created_at AS created_at, r.updated_at AS updated_at, e.payload_json AS routing_json
         FROM runs r
         LEFT JOIN run_events e ON e.run_id = r.id AND e.type = 'routing_decision'
        WHERE r.tenant_id = ? AND r.status IN (${placeholders}) AND r.created_at >= ?
        ORDER BY r.created_at DESC
        LIMIT ?`,
      tenantId, ...TERMINAL_STATES, since, maxRows,
    );
  } catch { runRows = []; }

  const runsById = new Map();
  for (const row of runRows) {
    if (!runsById.has(row.run_id)) {
      runsById.set(row.run_id, { id: row.run_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, taskType: null });
    }
    const run = runsById.get(row.run_id);
    if (!run.taskType && row.routing_json) {
      const payload = parseJsonSafe(row.routing_json, {});
      const taskType = payload?.taskType ?? payload?.details?.taskType;
      if (taskType) run.taskType = String(taskType).slice(0, 40);
    }
  }

  // --- Which model served each run (run_usage) ----------------------------
  let usageRows = [];
  try {
    usageRows = db.all(
      `SELECT run_id, model, provider, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost
         FROM run_usage
        WHERE tenant_id = ? AND created_at >= ?
        GROUP BY run_id, model`,
      tenantId, since,
    );
  } catch { usageRows = []; }
  const usageByRun = new Map();
  for (const row of usageRows) {
    if (!usageByRun.has(row.run_id)) usageByRun.set(row.run_id, []);
    usageByRun.get(row.run_id).push({ model: row.model, provider: row.provider, tokens: Number(row.tokens) || 0, cost: Number(row.cost) || 0 });
  }

  // --- Tool call outcomes -------------------------------------------------
  let toolRows = [];
  try {
    toolRows = db.all(
      `SELECT tc.tool_id AS tool_id, tc.status AS status, COUNT(*) AS n
         FROM tool_calls tc JOIN runs r ON r.id = tc.run_id
        WHERE r.tenant_id = ? AND r.created_at >= ?
        GROUP BY tc.tool_id, tc.status`,
      tenantId, since,
    );
  } catch { toolRows = []; }

  // --- Aggregate per (taskType, model) ------------------------------------
  const models = {};
  let modelObservations = 0;
  for (const run of runsById.values()) {
    const taskType = run.taskType || 'general';
    const success = SUCCESS.has(run.status);
    const latency = Date.parse(run.updatedAt) - Date.parse(run.createdAt);
    const atMs = Date.parse(run.createdAt);
    for (const usage of usageByRun.get(run.id) ?? []) {
      if (!KNOWN_MODELS.has(usage.model)) continue;
      if (!models[taskType]) models[taskType] = {};
      const bucket = models[taskType][usage.model] ??= { attempts: 0, successes: 0, tokens: 0, costUsd: 0, latencySum: 0, latencyN: 0, obs: [] };
      bucket.attempts += 1;
      if (success) bucket.successes += 1;
      bucket.tokens += usage.tokens;
      bucket.costUsd += usage.cost;
      bucket.obs.push({ success, atMs });
      if (Number.isFinite(latency) && latency >= 0) { bucket.latencySum += latency; bucket.latencyN += 1; }
      modelObservations += 1;
    }
  }
  for (const table of Object.values(models)) {
    for (const [modelId, bucket] of Object.entries(table)) {
      const weighted = weightedStats(bucket.obs, { halfLifeHours, nowMs });
      table[modelId] = {
        attempts: bucket.attempts,
        successes: bucket.successes,
        successRate: round(bucket.attempts ? bucket.successes / bucket.attempts : 0),
        smoothedSuccessRate: round(smoothedRate(bucket.successes, bucket.attempts)),
        confidence: round(confidenceFor(bucket.attempts)),
        avgCostUsd: round(bucket.attempts ? bucket.costUsd / bucket.attempts : 0, 6),
        avgTokens: Math.round(bucket.attempts ? bucket.tokens / bucket.attempts : 0),
        avgLatencyMs: bucket.latencyN ? Math.round(bucket.latencySum / bucket.latencyN) : null,
        // v2 recency-aware fields (additive; v1 fields above are untouched).
        effectiveSamples: weighted.effectiveSamples,
        decayedSuccessRate: weighted.decayedSuccessRate,
        wilsonLowerBound: weighted.wilsonLowerBound,
        decayedConfidence: weighted.confidence,
      };
    }
  }

  // --- Aggregate per tool -------------------------------------------------
  const tools = {};
  let toolCalls = 0;
  for (const row of toolRows) {
    const bucket = tools[row.tool_id] ??= { calls: 0, failures: 0 };
    const n = Number(row.n) || 0;
    bucket.calls += n;
    if (row.status === 'failed') bucket.failures += n;
    toolCalls += n;
  }
  for (const [toolId, bucket] of Object.entries(tools)) {
    const successes = Math.max(0, bucket.calls - bucket.failures);
    tools[toolId] = {
      calls: bucket.calls,
      failures: bucket.failures,
      successRate: round(bucket.calls ? successes / bucket.calls : 0),
      smoothedSuccessRate: round(smoothedRate(successes, bucket.calls)),
      confidence: round(confidenceFor(bucket.calls)),
    };
  }

  // --- Recovery + strategy: one row per terminal run's decision events ----
  let eventRows = [];
  try {
    eventRows = db.all(
      `SELECT e.run_id AS run_id, e.type AS etype, e.payload_json AS payload_json
         FROM run_events e JOIN runs r ON r.id = e.run_id
        WHERE r.tenant_id = ? AND r.status IN (${placeholders}) AND r.created_at >= ?
          AND e.type IN ('self_healing','autonomous_decision','planning_started','run_finished')
        LIMIT 20000`,
      tenantId, ...TERMINAL_STATES, since,
    );
  } catch { eventRows = []; }

  const recoveryByRun = new Map(); // runId -> Set("FAILURE_KIND|action")
  const multiAgentRuns = new Set();
  for (const row of eventRows) {
    if (!runsById.has(row.run_id)) continue;
    const details = payloadDetails(parseJsonSafe(row.payload_json, {}));
    if (row.etype === 'self_healing') {
      const action = String(details.action || '').toLowerCase();
      const failureKind = String(details.failureKind || '').toUpperCase();
      if (LEARNABLE_RECOVERY_ACTIONS.includes(action) && KNOWN_FAILURE_KINDS.has(failureKind)) {
        const set = recoveryByRun.get(row.run_id) ?? new Set();
        set.add(`${failureKind}|${action}`);
        recoveryByRun.set(row.run_id, set);
      }
    } else if (row.etype === 'autonomous_decision') {
      // 'recover' means a replan was attempted; record it (deduped with the
      // self_healing 'replan' row) so a run without a self_healing event still
      // contributes its recovery outcome.
      const action = String(details.action || '').toLowerCase();
      const failureKind = String(details.failureKind || '').toUpperCase();
      if (action === 'recover' && KNOWN_FAILURE_KINDS.has(failureKind)) {
        const set = recoveryByRun.get(row.run_id) ?? new Set();
        set.add(`${failureKind}|replan`);
        recoveryByRun.set(row.run_id, set);
      }
    } else if (details.multiAgent === true) {
      multiAgentRuns.add(row.run_id);
    }
  }
  // A multi-agent run also writes a run_usage row with provider 'multi-agent'.
  try {
    for (const row of db.all(`SELECT DISTINCT run_id FROM run_usage WHERE tenant_id = ? AND provider = 'multi-agent' AND created_at >= ?`, tenantId, since)) {
      if (runsById.has(row.run_id)) multiAgentRuns.add(row.run_id);
    }
  } catch { /* optional signal */ }

  const recoveryObs = {}; // failureKind -> action -> observations[]
  for (const [runId, pairs] of recoveryByRun) {
    const run = runsById.get(runId);
    if (!run) continue;
    const success = SUCCESS.has(run.status);
    const atMs = Date.parse(run.createdAt);
    for (const pair of pairs) {
      const [failureKind, action] = pair.split('|');
      ((recoveryObs[failureKind] ??= {})[action] ??= []).push({ success, atMs });
    }
  }
  const recovery = {};
  let recoveryObservations = 0;
  for (const [failureKind, table] of Object.entries(recoveryObs)) {
    recovery[failureKind] = {};
    for (const [action, obs] of Object.entries(table)) {
      recovery[failureKind][action] = weightedStats(obs, { halfLifeHours, nowMs });
      recoveryObservations += obs.length;
    }
  }

  const strategyObs = {}; // taskType -> strategy -> observations[]
  for (const run of runsById.values()) {
    const taskType = run.taskType || 'general';
    const strategy = multiAgentRuns.has(run.id) ? 'multi-agent' : 'single-agent';
    (((strategyObs[taskType] ??= {})[strategy] ??= [])).push({ success: SUCCESS.has(run.status), atMs: Date.parse(run.createdAt) });
  }
  const strategies = {};
  let strategyObservations = 0;
  for (const [taskType, table] of Object.entries(strategyObs)) {
    strategies[taskType] = {};
    for (const [strategy, obs] of Object.entries(table)) {
      strategies[taskType][strategy] = weightedStats(obs, { halfLifeHours, nowMs });
      strategyObservations += obs.length;
    }
  }

  // --- Execution: per (taskType, tool) reliability ------------------------
  let execRows = [];
  try {
    execRows = db.all(
      `SELECT tc.tool_id AS tool_id, tc.status AS status, tc.created_at AS created_at, e.payload_json AS routing_json
         FROM tool_calls tc JOIN runs r ON r.id = tc.run_id
         LEFT JOIN run_events e ON e.run_id = r.id AND e.type = 'routing_decision'
        WHERE r.tenant_id = ? AND r.created_at >= ?
        LIMIT 20000`,
      tenantId, since,
    );
  } catch { execRows = []; }
  const execObs = {}; // taskType -> toolId -> observations[]
  for (const row of execRows) {
    const routing = row.routing_json ? parseJsonSafe(row.routing_json, {}) : {};
    const taskType = String(routing?.taskType ?? routing?.details?.taskType ?? 'general').slice(0, 40) || 'general';
    const success = row.status !== 'failed';
    const atMs = Date.parse(row.created_at);
    (((execObs[taskType] ??= {})[row.tool_id] ??= [])).push({ success, atMs });
  }
  const execution = {};
  for (const [taskType, table] of Object.entries(execObs)) {
    execution[taskType] = {};
    for (const [toolId, obs] of Object.entries(table)) {
      execution[taskType][toolId] = weightedStats(obs, { halfLifeHours, nowMs });
    }
  }

  return {
    version: EXPERIENCE_VERSION,
    generatedAt,
    windowHours: boundedWindow,
    halfLifeHours: Math.max(1, Number(halfLifeHours) || DEFAULT_DECAY_HALF_LIFE_HOURS),
    tenantId,
    sampleSize: { runs: runsById.size, modelObservations, toolCalls, recoveryObservations, strategyObservations },
    models,
    tools,
    recovery,
    strategies,
    execution,
  };
}

/**
 * The model prior the router consumes: `{ [taskType]: { [modelId]: { successRate,
 * confidence, attempts } } }`. `successRate` is the Bayesian-smoothed rate so a
 * model with few observations stays close to the neutral prior.
 */
export function modelPriorFromSnapshot(snapshot) {
  const prior = {};
  for (const [taskType, table] of Object.entries(snapshot?.models ?? {})) {
    const bucket = {};
    for (const [modelId, stats] of Object.entries(table)) {
      bucket[modelId] = {
        successRate: Number(stats.smoothedSuccessRate),
        confidence: Number(stats.confidence),
        attempts: Number(stats.attempts) || 0,
      };
    }
    if (Object.keys(bucket).length) prior[taskType] = bucket;
  }
  return prior;
}

/** The tool reliability map: `{ [toolId]: { successRate, confidence, calls } }`. */
export function toolReliabilityFromSnapshot(snapshot) {
  const reliability = {};
  for (const [toolId, stats] of Object.entries(snapshot?.tools ?? {})) {
    reliability[toolId] = {
      successRate: Number(stats.smoothedSuccessRate),
      confidence: Number(stats.confidence),
      calls: Number(stats.calls) || 0,
    };
  }
  return reliability;
}

// -----------------------------------------------------------------------------
// v2 priors: recovery, strategy, execution
// -----------------------------------------------------------------------------

/**
 * Recovery prior: `{ [failureKind]: { [action]: { successRate, confidence,
 * attempts } } }`. `successRate` is the Wilson lower bound of
 * P(run succeeds | this action was used for this failure kind), so a recovery
 * action is only trusted once it has a proven track record.
 */
export function recoveryPriorFromSnapshot(snapshot) {
  const prior = {};
  for (const [failureKind, table] of Object.entries(snapshot?.recovery ?? {})) {
    const bucket = {};
    for (const [action, stats] of Object.entries(table)) {
      bucket[action] = {
        successRate: Number(stats.wilsonLowerBound),
        rawSuccessRate: Number(stats.successRate),
        confidence: Number(stats.confidence),
        attempts: Number(stats.attempts) || 0,
      };
    }
    if (Object.keys(bucket).length) prior[failureKind] = bucket;
  }
  return prior;
}

/**
 * Recommend the recovery action most likely to succeed for a failure kind.
 * Returns `null` (⇒ keep the static policy) unless a candidate clears the
 * confidence gate AND beats the runner-up by a real margin.
 */
export function recommendRecoveryAction(recoveryPrior, failureKind, { allowed = LEARNABLE_RECOVERY_ACTIONS, minConfidence = RECOVERY_MIN_CONFIDENCE, minMargin = RECOVERY_MIN_MARGIN } = {}) {
  const table = recoveryPrior?.[failureKind];
  if (!table) return null;
  const candidates = allowed
    .filter((action) => table[action] && table[action].confidence >= minConfidence && table[action].attempts >= MIN_OBSERVATIONS)
    .sort((a, b) => (table[b].successRate - table[a].successRate) || (table[b].confidence - table[a].confidence));
  if (!candidates.length) return null;
  const best = candidates[0];
  if (candidates.length > 1) {
    const runnerUp = candidates[1];
    if (table[best].successRate - table[runnerUp].successRate < minMargin) return null;
  }
  return { action: best, confidence: table[best].confidence, successRate: table[best].successRate, attempts: table[best].attempts };
}

/** Strategy prior: `{ [taskType]: { [strategy]: { successRate, confidence, attempts } } }`. */
export function strategyPriorFromSnapshot(snapshot) {
  const prior = {};
  for (const [taskType, table] of Object.entries(snapshot?.strategies ?? {})) {
    const bucket = {};
    for (const [strategy, stats] of Object.entries(table)) {
      bucket[strategy] = {
        successRate: Number(stats.wilsonLowerBound),
        rawSuccessRate: Number(stats.successRate),
        confidence: Number(stats.confidence),
        attempts: Number(stats.attempts) || 0,
      };
    }
    if (Object.keys(bucket).length) prior[taskType] = bucket;
  }
  return prior;
}

/**
 * Recommend the execution strategy for a task type. Requires BOTH strategies to
 * have real evidence and a clear winner (margin gate), so a task type with only
 * single-agent history never flips to multi-agent on thin data.
 */
export function recommendStrategy(strategyPrior, taskType, { minConfidence = STRATEGY_MIN_CONFIDENCE, minMargin = STRATEGY_MIN_MARGIN } = {}) {
  const table = strategyPrior?.[taskType];
  if (!table) return null;
  const entries = Object.entries(table)
    .filter(([, stats]) => stats.confidence >= minConfidence && stats.attempts >= MIN_OBSERVATIONS)
    .sort((a, b) => (b[1].successRate - a[1].successRate) || (b[1].confidence - a[1].confidence));
  if (entries.length < 2) return null; // need both strategies observed to compare
  const [best, runnerUp] = entries;
  const margin = best[1].successRate - runnerUp[1].successRate;
  if (margin < minMargin) return null;
  return { strategy: best[0], confidence: best[1].confidence, successRate: best[1].successRate, margin: round(margin), attempts: best[1].attempts };
}

/** Execution prior: `{ [taskType]: { [toolId]: { successRate, confidence, attempts } } }`. */
export function executionPriorFromSnapshot(snapshot) {
  const prior = {};
  for (const [taskType, table] of Object.entries(snapshot?.execution ?? {})) {
    const bucket = {};
    for (const [toolId, stats] of Object.entries(table)) {
      bucket[toolId] = {
        successRate: Number(stats.wilsonLowerBound),
        rawSuccessRate: Number(stats.successRate),
        confidence: Number(stats.confidence),
        attempts: Number(stats.attempts) || 0,
      };
    }
    if (Object.keys(bucket).length) prior[taskType] = bucket;
  }
  return prior;
}

/**
 * The tool the run should PREFER for a task type (the most reliable one with a
 * real margin over the next best), used to steer the plan toward tools that
 * actually work. Returns `null` when there is no confident winner.
 */
export function recommendTool(executionPrior, taskType, { exclude = [], minConfidence = EXECUTION_MIN_CONFIDENCE, minMargin = 0.15 } = {}) {
  const table = executionPrior?.[taskType];
  if (!table) return null;
  const excluded = new Set(exclude);
  const entries = Object.entries(table)
    .filter(([toolId, stats]) => !excluded.has(toolId) && stats.confidence >= minConfidence && stats.attempts >= MIN_OBSERVATIONS)
    .sort((a, b) => (b[1].successRate - a[1].successRate) || (b[1].attempts - a[1].attempts));
  if (entries.length < 2) return null;
  const [best, runnerUp] = entries;
  if (best[1].successRate - runnerUp[1].successRate < minMargin) return null;
  return { toolId: best[0], confidence: best[1].confidence, successRate: best[1].successRate, attempts: best[1].attempts };
}

/**
 * A conservative retry-budget adjustment: a tool that is PROVEN flaky for this
 * task type should not burn retries that historically never help. Only fires on
 * strong evidence (high confidence, very low success rate); otherwise the base
 * budget is returned unchanged.
 */
export function recommendRetryBudget({ executionPrior, taskType, toolId, base = 2, minConfidence = EXECUTION_MIN_CONFIDENCE, flakyThreshold = 0.3 } = {}) {
  const boundedBase = Math.max(1, Number(base) || 1);
  const stat = executionPrior?.[taskType]?.[toolId];
  if (!stat || stat.confidence < minConfidence || stat.attempts < MIN_OBSERVATIONS) return boundedBase;
  if (stat.successRate <= flakyThreshold) return 1; // proven futile retries -> fail fast to replan
  return boundedBase;
}

// -----------------------------------------------------------------------------
// Guidance + summary
// -----------------------------------------------------------------------------

/**
 * Bounded, human-readable guidance lines for the planner / recovery prompt.
 * Returned as an array so each line becomes its own bounded "note" (the Context
 * Compiler truncates per line), never one giant blob.
 */
export function experienceGuidance(snapshot, { maxTools = 6, maxModels = 3, maxRecovery = 4, maxStrategies = 3 } = {}) {
  if (!snapshot) return [];
  const lines = [];

  // Model performance per task type (only where there is real evidence).
  const modelLines = [];
  for (const [taskType, table] of Object.entries(snapshot.models ?? {})) {
    const entries = Object.entries(table)
      .filter(([, stats]) => stats.attempts >= MIN_OBSERVATIONS)
      .sort((a, b) => (b[1].smoothedSuccessRate - a[1].smoothedSuccessRate) || (b[1].attempts - a[1].attempts));
    if (!entries.length) continue;
    const [bestId, best] = entries[0];
    const [worstId, worst] = entries[entries.length - 1];
    let line = `${taskType}: ${bestId} succeeded ${Math.round(best.successRate * 100)}% (${best.attempts} runs)`;
    if (worstId !== bestId && worst.successRate + 0.15 < best.successRate) {
      line += `; prefer it over ${worstId} (${Math.round(worst.successRate * 100)}%)`;
    }
    modelLines.push(line);
    if (modelLines.length >= maxModels) break;
  }
  if (modelLines.length) lines.push(`Model performance by task type (from real runs): ${modelLines.join(' | ')}`);

  // Tools that failed often — the planner should verify preconditions or avoid.
  const toolEntries = Object.entries(snapshot.tools ?? {}).filter(([, stats]) => stats.calls >= MIN_OBSERVATIONS);
  const risky = toolEntries
    .filter(([, stats]) => stats.successRate < 0.7)
    .sort((a, b) => a[1].successRate - b[1].successRate)
    .slice(0, maxTools);
  if (risky.length) {
    lines.push(`Tools with a high failure rate in past runs (verify inputs/preconditions or choose an alternative): ${risky.map(([id, stats]) => `${id} ${Math.round(stats.successRate * 100)}% (${stats.calls})`).join(', ')}`);
  }

  // Highly reliable tools — safe defaults.
  const reliable = toolEntries
    .filter(([, stats]) => stats.successRate >= 0.9 && stats.calls >= 3)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, maxTools);
  if (reliable.length) {
    lines.push(`Reliable tools (high success): ${reliable.map(([id, stats]) => `${id} ${Math.round(stats.successRate * 100)}% (${stats.calls})`).join(', ')}`);
  }

  // Recovery: which action actually works for each failure kind (the "why").
  const recoveryPrior = recoveryPriorFromSnapshot(snapshot);
  const recoveryLines = [];
  for (const failureKind of Object.keys(recoveryPrior)) {
    const rec = recommendRecoveryAction(recoveryPrior, failureKind, { allowed: LEARNABLE_RECOVERY_ACTIONS });
    if (!rec) continue;
    recoveryLines.push(`${failureKind}: ${rec.action} succeeded ${Math.round(rec.successRate * 100)}% (${rec.attempts})`);
    if (recoveryLines.length >= maxRecovery) break;
  }
  if (recoveryLines.length) lines.push(`Recovery that worked for each failure kind (prefer it): ${recoveryLines.join(' | ')}`);

  // Strategy: which execution strategy wins for each task type (the "why").
  const strategyPrior = strategyPriorFromSnapshot(snapshot);
  const strategyLines = [];
  for (const taskType of Object.keys(strategyPrior)) {
    const rec = recommendStrategy(strategyPrior, taskType);
    if (!rec) continue;
    strategyLines.push(`${taskType}: ${rec.strategy} succeeded ${Math.round(rec.successRate * 100)}% (${rec.attempts}, margin ${Math.round(rec.margin * 100)}%)`);
    if (strategyLines.length >= maxStrategies) break;
  }
  if (strategyLines.length) lines.push(`Execution strategy that worked by task type (prefer it): ${strategyLines.join(' | ')}`);

  // Execution: the most reliable tool for a task type (the "how").
  const executionPrior = executionPriorFromSnapshot(snapshot);
  const executionLines = [];
  for (const taskType of Object.keys(executionPrior)) {
    const rec = recommendTool(executionPrior, taskType);
    if (!rec) continue;
    executionLines.push(`${taskType}: prefer ${rec.toolId} (${Math.round(rec.successRate * 100)}%, ${rec.attempts})`);
    if (executionLines.length >= maxStrategies) break;
  }
  if (executionLines.length) lines.push(`Most reliable tool by task type (prefer it): ${executionLines.join(' | ')}`);

  return lines;
}

/** Convenience: the guidance as a single newline-joined string (for logs/events). */
export function renderExperienceGuidance(snapshot, options) {
  return experienceGuidance(snapshot, options).join('\n');
}

/** A compact summary suitable for a run event / API response. */
export function summarizeExperience(snapshot) {
  if (!snapshot) return { available: false };
  return {
    available: true,
    version: snapshot.version,
    generatedAt: snapshot.generatedAt,
    windowHours: snapshot.windowHours,
    sampleSize: snapshot.sampleSize,
    taskTypes: Object.keys(snapshot.models ?? {}).length,
    tools: Object.keys(snapshot.tools ?? {}).length,
    recoveryKinds: Object.keys(snapshot.recovery ?? {}).length,
    strategyTaskTypes: Object.keys(snapshot.strategies ?? {}).length,
  };
}
