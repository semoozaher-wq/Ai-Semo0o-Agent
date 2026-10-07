/**
 * phase2-core/eval.mjs — Agent Evaluation & Benchmark Engine.
 *
 * A runner-agnostic scoring engine. A benchmark is a named set of tasks plus a
 * set of weighted evaluators; a runner is any async function `(task) => result`.
 * The engine executes the tasks, applies every evaluator, and produces a
 * deterministic report with per-task, per-evaluator and overall scores.
 *
 * It is deliberately free of any dependency on the agent runtime, the network,
 * or the filesystem, so the same engine can score the real agent loop
 * (scripts/agent-benchmark.mjs), the capability scorecard
 * (backend/ops/capability-benchmark.mjs) and unit tests alike.
 */

const now = () => new Date().toISOString();

/** Define a benchmark from tasks and evaluators (both optional, additive). */
export function defineBenchmark({ name, tasks = [], evaluators = [], options = {} } = {}) {
  return {
    name: name ?? 'benchmark',
    tasks: tasks.map((task, index) => ({ id: task.id ?? `task_${index + 1}`, weight: task.weight ?? 1, ...task })),
    evaluators: evaluators.map((evaluator) => normalizeEvaluator(evaluator)),
    options,
  };
}

function normalizeEvaluator(evaluator) {
  if (typeof evaluator === 'function') return { id: evaluator.name || 'evaluator', name: evaluator.name || 'evaluator', weight: 1, check: evaluator };
  return { id: evaluator.id, name: evaluator.name ?? evaluator.id, weight: evaluator.weight ?? 1, check: evaluator.check };
}

/** Create an evaluator. `check(result, task)` may return a boolean or {passed, detail}. */
export function evaluator(id, check, options = {}) {
  return { id, name: options.name ?? id, weight: options.weight ?? 1, check };
}

/** Evaluator: a top-level field of the result equals an expected value. */
export function expectField(field, expected, options = {}) {
  return evaluator(options.id ?? `field:${field}`, (result) => ({
    passed: result?.[field] === expected,
    detail: `${field}=${JSON.stringify(result?.[field])} (expected ${JSON.stringify(expected)})`,
  }), options);
}

/** Evaluator: an arbitrary predicate over the result is truthy. */
export function expectTruthy(predicate, options = {}) {
  return evaluator(options.id ?? 'truthy', (result, task) => {
    const passed = Boolean(predicate(result, task));
    return { passed, detail: passed ? 'ok' : 'predicate returned falsy' };
  }, options);
}

/** Evaluator: the result array/string includes a value. */
export function expectIncludes(value, options = {}) {
  return evaluator(options.id ?? `includes:${value}`, (result) => {
    const haystack = Array.isArray(result) ? result : String(result ?? '');
    const passed = Array.isArray(haystack) ? haystack.includes(value) : haystack.includes(value);
    return { passed, detail: passed ? 'ok' : `missing ${JSON.stringify(value)}` };
  }, options);
}

/**
 * Score a single result against evaluators. Async because evaluators may be
 * async; awaiting a non-promise is a no-op, so sync evaluators work unchanged.
 */
export async function scoreResult(result, evaluators = [], task = {}, error = null) {
  const details = [];
  let weightSum = 0;
  let weighted = 0;
  for (const raw of evaluators) {
    const item = normalizeEvaluator(raw);
    const weight = item.weight ?? 1;
    weightSum += weight;
    let outcome;
    if (error) {
      outcome = { passed: false, detail: `runner error: ${error}` };
    } else {
      try {
        outcome = await item.check(result, task);
      } catch (thrown) {
        outcome = { passed: false, detail: `evaluator error: ${thrown instanceof Error ? thrown.message : String(thrown)}` };
      }
    }
    const passed = typeof outcome === 'boolean' ? outcome : Boolean(outcome?.passed);
    const detail = typeof outcome === 'object' && outcome !== null ? outcome.detail ?? null : null;
    if (passed) weighted += weight;
    details.push({ id: item.id, name: item.name, passed, weight, detail });
  }
  const score = weightSum === 0 ? 0 : Math.round((weighted / weightSum) * 100);
  return { score, passed: details.length > 0 && details.every((detail) => detail.passed), details };
}

function summarize(results, evaluators) {
  const total = results.length;
  const passed = results.filter((result) => result.ok).length;
  const byEvaluator = {};
  for (const raw of evaluators) {
    const item = normalizeEvaluator(raw);
    const items = results.flatMap((result) => result.evaluators.filter((detail) => detail.id === item.id));
    const ok = items.filter((detail) => detail.passed).length;
    byEvaluator[item.id] = { passed: ok, failed: items.length - ok, rate: items.length ? Math.round((ok / items.length) * 100) : 0 };
  }
  const weightSum = results.reduce((sum, result) => sum + result.weight, 0) || 1;
  const score = Math.round(results.reduce((sum, result) => sum + result.score * result.weight, 0) / weightSum);
  return { total, passed, failed: total - passed, passRate: total ? Math.round((passed / total) * 100) : 0, score, byEvaluator };
}

/** Run a benchmark against a runner and return a full report. */
export async function runBenchmark(benchmark, runner, options = {}) {
  if (typeof runner !== 'function') throw new Error('BENCHMARK_RUNNER_REQUIRED');
  const startedAt = now();
  const t0 = Date.now();
  const results = [];
  for (const task of benchmark.tasks) {
    if (options.signal?.aborted) break;
    const taskStart = Date.now();
    let result = null;
    let error = null;
    try {
      result = await runner(task, { signal: options.signal });
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
    }
    const evaluation = await scoreResult(result, benchmark.evaluators, task, error);
    results.push({
      id: task.id,
      name: task.name ?? task.id,
      weight: task.weight ?? 1,
      ok: !error && evaluation.passed,
      durationMs: Date.now() - taskStart,
      result: error ? null : result,
      error,
      score: evaluation.score,
      evaluators: evaluation.details,
    });
  }
  return {
    name: benchmark.name,
    startedAt,
    finishedAt: now(),
    durationMs: Date.now() - t0,
    tasks: results,
    summary: summarize(results, benchmark.evaluators),
  };
}

/** Compare two reports to detect regressions (used by capability benchmarking). */
export function compareReports(baseline, current) {
  const base = baseline?.summary?.score ?? 0;
  const next = current?.summary?.score ?? 0;
  const delta = next - base;
  const regressions = [];
  const improvements = [];
  const baseByEvaluator = baseline?.summary?.byEvaluator ?? {};
  for (const [id, value] of Object.entries(current?.summary?.byEvaluator ?? {})) {
    const previous = baseByEvaluator[id]?.rate ?? 0;
    if (value.rate < previous) regressions.push({ id, from: previous, to: value.rate });
    else if (value.rate > previous) improvements.push({ id, from: previous, to: value.rate });
  }
  return {
    baselineScore: base,
    currentScore: next,
    delta,
    improved: delta > 0,
    regressed: delta < 0,
    regressions,
    improvements,
  };
}
