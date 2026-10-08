import { timingSafeEqual } from 'node:crypto';
import { evaluateRuns } from '../agent/evaluation.mjs';

// ===========================================================================
// Platform observability: a Prometheus text exposition endpoint plus SLO
// computation. Everything is derived from durable rows (runs, tool_calls,
// run_usage, email_outbox, self_improve_*) and process stats, so the numbers
// are real and reproducible rather than approximated.
// ===========================================================================

export const TERMINAL_RUN_STATES = Object.freeze(['completed', 'completed_with_warnings', 'failed', 'cancelled', 'unverified', 'blocked']);
export const SUCCESS_RUN_STATES = Object.freeze(['completed', 'completed_with_warnings']);

export const SLO_TARGETS = Object.freeze({
  runSuccessRatio: 0.95,
  toolSuccessRatio: 0.98,
});

function rowsToMap(rows, key = 'status', value = 'n') {
  const map = {};
  for (const row of rows) map[row[key]] = Number(row[value]) || 0;
  return map;
}

function sum(map) {
  return Object.values(map).reduce((total, value) => total + value, 0);
}

function sinceIso(windowHours, reference) {
  return new Date(reference.getTime() - windowHours * 3_600_000).toISOString();
}

export function collectMetrics(db, { windowHours = 24, now: nowFn = () => new Date() } = {}) {
  const reference = nowFn();
  const since = sinceIso(windowHours, reference);
  const runsByStatus = rowsToMap(db.all('SELECT status, COUNT(*) AS n FROM runs GROUP BY status'));
  const runsWindow = rowsToMap(db.all('SELECT status, COUNT(*) AS n FROM runs WHERE created_at>=? GROUP BY status', since));
  const toolByStatus = rowsToMap(db.all('SELECT status, COUNT(*) AS n FROM tool_calls GROUP BY status'));
  const toolWindow = rowsToMap(db.all('SELECT status, COUNT(*) AS n FROM tool_calls WHERE created_at>=? GROUP BY status', since));
  const usage = db.get('SELECT COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost, COUNT(*) AS runs FROM run_usage WHERE created_at>=?', since);
  const outbox = rowsToMap(db.all('SELECT status, COUNT(*) AS n FROM email_outbox GROUP BY status'));
  const proposals = rowsToMap(db.all('SELECT status, COUNT(*) AS n FROM self_improve_proposals GROUP BY status'));
  const tenants = db.get('SELECT COUNT(*) AS n FROM tenants').n;
  const users = db.get('SELECT COUNT(*) AS n FROM users').n;
  const activeSessions = db.get('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NULL AND expires_at > ?', reference.toISOString()).n;
  const queueDepth = (runsByStatus.queued ?? 0) + (runsByStatus.running ?? 0) + (runsByStatus.waiting_approval ?? 0);
  // Artifact ledger + scheduled-trigger health (additive; both tables always exist).
  const artifactTotals = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes),0) AS bytes FROM artifacts');
  const artifactsByKind = rowsToMap(db.all("SELECT COALESCE(kind,'unknown') AS kind, COUNT(*) AS n FROM artifacts GROUP BY kind"), 'kind');
  const triggerTotals = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(enabled),0) AS enabled FROM scheduled_triggers');
  const triggersDue = db.get('SELECT COUNT(*) AS n FROM scheduled_triggers WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?', reference.toISOString()).n;
  const memory = process.memoryUsage();
  // Reusable evaluation aggregate (additive): a windowed quality scorecard built
  // from the SAME durable rows, bounded so /metrics stays cheap. Fail-soft: a
  // malformed row can never break the metrics endpoint.
  let evaluation = null;
  try {
    const scorecard = evaluateRuns(db, { windowHours, limit: 200, now: nowFn });
    evaluation = {
      runsEvaluated: scorecard.count,
      successRatio: scorecard.successRatio,
      avgQualityScore: scorecard.avgQualityScore,
      avgToolEfficiency: scorecard.avgToolEfficiency,
      avgEvidenceCompleteness: scorecard.avgEvidenceCompleteness,
      interventionRate: scorecard.interventionRate,
      totalCostUsd: scorecard.totalCostUsd,
      costPerSuccess: scorecard.costPerSuccess,
      avgLatencyMs: scorecard.avgLatencyMs,
    };
  } catch { evaluation = null; }
  return {
    windowHours,
    generatedAt: reference.toISOString(),
    runs: { byStatus: runsByStatus, window: runsWindow },
    toolCalls: { byStatus: toolByStatus, window: toolWindow },
    usage: { tokens: Number(usage.tokens) || 0, costUsd: Number(usage.cost) || 0, runs: Number(usage.runs) || 0 },
    outbox,
    proposals,
    artifacts: { total: Number(artifactTotals.n) || 0, bytes: Number(artifactTotals.bytes) || 0, byKind: artifactsByKind },
    triggers: { total: Number(triggerTotals.n) || 0, enabled: Number(triggerTotals.enabled) || 0, due: Number(triggersDue) || 0 },
    evaluation,
    tenants,
    users,
    activeSessions,
    queueDepth,
    process: { uptimeSeconds: Math.round(process.uptime()), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
  };
}

export function computeSlo(db, { windowHours = 24, now: nowFn = () => new Date(), targets = SLO_TARGETS } = {}) {
  const since = sinceIso(windowHours, nowFn());
  const placeholders = TERMINAL_RUN_STATES.map(() => '?').join(',');
  const runRows = rowsToMap(db.all(`SELECT status, COUNT(*) AS n FROM runs WHERE created_at>=? AND status IN (${placeholders}) GROUP BY status`, since, ...TERMINAL_RUN_STATES));
  const totalRuns = sum(runRows);
  const successRuns = SUCCESS_RUN_STATES.reduce((total, state) => total + (runRows[state] ?? 0), 0);
  const runSuccessRatio = totalRuns ? successRuns / totalRuns : 1;

  const toolRows = rowsToMap(db.all('SELECT status, COUNT(*) AS n FROM tool_calls WHERE created_at>=? GROUP BY status', since));
  const totalToolCalls = sum(toolRows);
  const toolSuccessRatio = totalToolCalls ? (toolRows.success ?? 0) / totalToolCalls : 1;

  return {
    windowHours,
    runSuccessRatio,
    runSuccessTarget: targets.runSuccessRatio,
    runSuccessMet: runSuccessRatio >= targets.runSuccessRatio,
    toolSuccessRatio,
    toolSuccessTarget: targets.toolSuccessRatio,
    toolSuccessMet: toolSuccessRatio >= targets.toolSuccessRatio,
    totalRuns,
    totalToolCalls,
  };
}

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metric(lines, name, type, help, samples) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  for (const sample of samples) {
    const labels = sample.labels ? `{${Object.entries(sample.labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}` : '';
    lines.push(`${name}${labels} ${sample.value}`);
  }
}

export function renderPrometheus(metrics, slo) {
  const lines = [];
  const runSamples = Object.entries(metrics.runs.byStatus).map(([status, value]) => ({ labels: { status }, value }));
  metric(lines, 'semo0o_runs_total', 'gauge', 'Total runs by status.', runSamples.length ? runSamples : [{ value: 0 }]);
  const runWindowSamples = Object.entries(metrics.runs.window).map(([status, value]) => ({ labels: { status }, value }));
  metric(lines, 'semo0o_runs_window_total', 'gauge', `Runs created in the last ${metrics.windowHours}h by status.`, runWindowSamples.length ? runWindowSamples : [{ value: 0 }]);
  metric(lines, 'semo0o_queue_depth', 'gauge', 'Runs currently queued, running, or awaiting approval.', [{ value: metrics.queueDepth }]);
  const toolSamples = Object.entries(metrics.toolCalls.byStatus).map(([status, value]) => ({ labels: { status }, value }));
  metric(lines, 'semo0o_tool_calls_total', 'gauge', 'Tool calls by status.', toolSamples.length ? toolSamples : [{ value: 0 }]);
  metric(lines, 'semo0o_tokens_total', 'gauge', `Total tokens consumed in the last ${metrics.windowHours}h.`, [{ value: metrics.usage.tokens }]);
  metric(lines, 'semo0o_cost_usd_total', 'gauge', `Total model cost (USD) in the last ${metrics.windowHours}h.`, [{ value: metrics.usage.costUsd }]);
  const outboxSamples = Object.entries(metrics.outbox).map(([status, value]) => ({ labels: { status }, value }));
  metric(lines, 'semo0o_email_outbox_total', 'gauge', 'Transactional emails by delivery status.', outboxSamples.length ? outboxSamples : [{ value: 0 }]);
  const proposalSamples = Object.entries(metrics.proposals).map(([status, value]) => ({ labels: { status }, value }));
  metric(lines, 'semo0o_self_improve_proposals_total', 'gauge', 'Self-improvement proposals by status.', proposalSamples.length ? proposalSamples : [{ value: 0 }]);
  const artifactSamples = Object.entries(metrics.artifacts.byKind).map(([kind, value]) => ({ labels: { kind }, value }));
  metric(lines, 'semo0o_artifacts_total', 'gauge', 'Recorded artifacts by kind.', artifactSamples.length ? artifactSamples : [{ value: 0 }]);
  metric(lines, 'semo0o_artifact_bytes_total', 'gauge', 'Total bytes recorded across all artifacts.', [{ value: metrics.artifacts.bytes }]);
  metric(lines, 'semo0o_scheduled_triggers_total', 'gauge', 'Scheduled triggers by enabled state.', [
    { labels: { state: 'enabled' }, value: metrics.triggers.enabled },
    { labels: { state: 'disabled' }, value: metrics.triggers.total - metrics.triggers.enabled },
  ]);
  metric(lines, 'semo0o_scheduled_triggers_due', 'gauge', 'Enabled triggers whose next run is due now.', [{ value: metrics.triggers.due }]);
  metric(lines, 'semo0o_tenants_total', 'gauge', 'Number of tenants.', [{ value: metrics.tenants }]);
  metric(lines, 'semo0o_users_total', 'gauge', 'Number of users.', [{ value: metrics.users }]);
  metric(lines, 'semo0o_active_sessions', 'gauge', 'Active (unexpired, unrevoked) sessions.', [{ value: metrics.activeSessions }]);
  metric(lines, 'semo0o_process_uptime_seconds', 'gauge', 'Process uptime in seconds.', [{ value: metrics.process.uptimeSeconds }]);
  metric(lines, 'semo0o_process_resident_memory_bytes', 'gauge', 'Resident memory in bytes.', [{ value: metrics.process.rssBytes }]);
  metric(lines, 'semo0o_process_heap_used_bytes', 'gauge', 'Heap used in bytes.', [{ value: metrics.process.heapUsedBytes }]);
  metric(lines, 'semo0o_slo_run_success_ratio', 'gauge', 'Run success ratio over the window.', [{ value: slo.runSuccessRatio }]);
  metric(lines, 'semo0o_slo_run_success_target', 'gauge', 'Run success ratio target.', [{ value: slo.runSuccessTarget }]);
  metric(lines, 'semo0o_slo_run_success_met', 'gauge', '1 when the run success SLO is met.', [{ value: slo.runSuccessMet ? 1 : 0 }]);
  metric(lines, 'semo0o_slo_tool_success_ratio', 'gauge', 'Tool success ratio over the window.', [{ value: slo.toolSuccessRatio }]);
  metric(lines, 'semo0o_slo_tool_success_target', 'gauge', 'Tool success ratio target.', [{ value: slo.toolSuccessTarget }]);
  metric(lines, 'semo0o_slo_tool_success_met', 'gauge', '1 when the tool success SLO is met.', [{ value: slo.toolSuccessMet ? 1 : 0 }]);
  // Evaluation scorecard gauges (only when the aggregate is available).
  const evaluation = metrics.evaluation;
  if (evaluation) {
    const num = (value) => (Number.isFinite(value) ? value : 0);
    metric(lines, 'semo0o_eval_runs_evaluated', 'gauge', 'Runs included in the evaluation window.', [{ value: num(evaluation.runsEvaluated) }]);
    metric(lines, 'semo0o_eval_success_ratio', 'gauge', 'Success ratio across evaluated runs.', [{ value: num(evaluation.successRatio) }]);
    metric(lines, 'semo0o_eval_avg_quality_score', 'gauge', 'Average composite quality score (0..100).', [{ value: num(evaluation.avgQualityScore) }]);
    metric(lines, 'semo0o_eval_avg_tool_efficiency', 'gauge', 'Average tool-use success ratio.', [{ value: num(evaluation.avgToolEfficiency) }]);
    metric(lines, 'semo0o_eval_avg_evidence_completeness', 'gauge', 'Average evidence completeness (verified checks / checks).', [{ value: num(evaluation.avgEvidenceCompleteness) }]);
    metric(lines, 'semo0o_eval_intervention_rate', 'gauge', 'Fraction of runs that required human approval.', [{ value: num(evaluation.interventionRate) }]);
    metric(lines, 'semo0o_eval_cost_per_success_usd', 'gauge', 'Model cost (USD) per successful run.', [{ value: num(evaluation.costPerSuccess) }]);
    metric(lines, 'semo0o_eval_avg_latency_ms', 'gauge', 'Average run latency in milliseconds.', [{ value: num(evaluation.avgLatencyMs) }]);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The /metrics endpoint is gated to loopback callers or a caller presenting the
 * configured METRICS_TOKEN. Constant-time comparison avoids token oracle leaks.
 */
export function isMetricsAuthorized({ remoteAddress = '', token = null, expectedToken = '' } = {}) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress);
  if (loopback) return true;
  if (!expectedToken || !token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(String(expectedToken));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
