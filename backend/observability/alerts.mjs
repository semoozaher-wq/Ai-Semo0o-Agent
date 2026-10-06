import { collectMetrics, computeSlo } from './metrics.mjs';

// ===========================================================================
// Alert evaluation.
//
// Turns the durable metrics + SLO computation into actionable, severity-ranked
// alerts. Rules are pure functions over `(metrics, slo, thresholds)` so they are
// deterministic and unit-testable. A minimum sample size gates the SLO rules so a
// brand-new tenant with two failed runs does not page anyone.
//
// This is the "alert rules" half of monitoring; a Prometheus scrape of
// `semo0o_alert_firing` (rendered by `renderAlertMetrics`) is what an external
// Alertmanager consumes, and `GET /ops/alerts` is the in-product view.
// ===========================================================================

export const ALERT_SEVERITIES = Object.freeze(['info', 'warning', 'critical']);

export const DEFAULT_THRESHOLDS = Object.freeze({
  minRunsForSlo: 20,
  minToolCallsForSlo: 20,
  queueDepthWarning: 25,
  queueDepthCritical: 100,
  failedEmailsWarning: 1,
  failedEmailsCritical: 10,
  rssWarningBytes: 1_500_000_000,
  rssCriticalBytes: 3_000_000_000,
});

// Each rule returns an alert object or null. Keeping them as data makes the
// catalog introspectable (an operator UI can list what will page them).
export const ALERT_RULES = Object.freeze([
  {
    id: 'run_success_slo_breach',
    severity: 'critical',
    summary: 'Run success ratio is below the SLO target',
    evaluate: (metrics, slo, thresholds) => (slo.totalRuns >= thresholds.minRunsForSlo && !slo.runSuccessMet
      ? { ratio: slo.runSuccessRatio, target: slo.runSuccessTarget, totalRuns: slo.totalRuns }
      : null),
  },
  {
    id: 'tool_success_slo_breach',
    severity: 'warning',
    summary: 'Tool success ratio is below the SLO target',
    evaluate: (metrics, slo, thresholds) => (slo.totalToolCalls >= thresholds.minToolCallsForSlo && !slo.toolSuccessMet
      ? { ratio: slo.toolSuccessRatio, target: slo.toolSuccessTarget, totalToolCalls: slo.totalToolCalls }
      : null),
  },
  {
    id: 'queue_backlog',
    severity: 'critical',
    summary: 'Run queue depth is critically high',
    evaluate: (metrics, slo, thresholds) => (metrics.queueDepth >= thresholds.queueDepthCritical
      ? { queueDepth: metrics.queueDepth, threshold: thresholds.queueDepthCritical }
      : null),
  },
  {
    id: 'queue_backlog',
    severity: 'warning',
    summary: 'Run queue depth is elevated',
    evaluate: (metrics, slo, thresholds) => (metrics.queueDepth >= thresholds.queueDepthWarning && metrics.queueDepth < thresholds.queueDepthCritical
      ? { queueDepth: metrics.queueDepth, threshold: thresholds.queueDepthWarning }
      : null),
  },
  {
    id: 'email_delivery_failures',
    severity: 'critical',
    summary: 'Transactional email delivery is failing',
    evaluate: (metrics, slo, thresholds) => ((metrics.outbox.failed ?? 0) >= thresholds.failedEmailsCritical
      ? { failed: metrics.outbox.failed }
      : null),
  },
  {
    id: 'email_delivery_failures',
    severity: 'warning',
    summary: 'Some transactional emails failed to deliver',
    evaluate: (metrics, slo, thresholds) => {
      const failed = metrics.outbox.failed ?? 0;
      return failed >= thresholds.failedEmailsWarning && failed < thresholds.failedEmailsCritical ? { failed } : null;
    },
  },
  {
    id: 'memory_pressure',
    severity: 'critical',
    summary: 'Process resident memory is critically high',
    evaluate: (metrics, slo, thresholds) => (metrics.process.rssBytes >= thresholds.rssCriticalBytes
      ? { rssBytes: metrics.process.rssBytes, threshold: thresholds.rssCriticalBytes }
      : null),
  },
  {
    id: 'memory_pressure',
    severity: 'warning',
    summary: 'Process resident memory is elevated',
    evaluate: (metrics, slo, thresholds) => (metrics.process.rssBytes >= thresholds.rssWarningBytes && metrics.process.rssBytes < thresholds.rssCriticalBytes
      ? { rssBytes: metrics.process.rssBytes, threshold: thresholds.rssWarningBytes }
      : null),
  },
  {
    id: 'self_improve_regression',
    severity: 'warning',
    summary: 'A self-improvement proposal regressed and was rolled back',
    evaluate: (metrics) => ((metrics.proposals.regressed ?? 0) > 0 ? { regressed: metrics.proposals.regressed } : null),
  },
]);

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

export function evaluateAlerts(db, { windowHours = 24, now, thresholds = DEFAULT_THRESHOLDS } = {}) {
  // `now` may be supplied as a Date (convenient in tests) or as a clock function
  // (matching metrics.mjs). Normalise so both call styles work.
  const nowFn = typeof now === 'function' ? now : now ? () => now : undefined;
  const metrics = collectMetrics(db, { windowHours, ...(nowFn ? { now: nowFn } : {}) });
  const slo = computeSlo(db, { windowHours, ...(nowFn ? { now: nowFn } : {}) });
  const alerts = [];
  for (const rule of ALERT_RULES) {
    const detail = rule.evaluate(metrics, slo, thresholds);
    if (detail) alerts.push({ id: rule.id, severity: rule.severity, summary: rule.summary, detail });
  }
  alerts.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const firing = alerts.filter((alert) => alert.severity !== 'info');
  return {
    windowHours,
    generatedAt: metrics.generatedAt,
    ok: firing.length === 0,
    highestSeverity: firing.reduce((worst, alert) => (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[worst] ? alert.severity : worst), 'info'),
    alerts,
    firing,
    metrics,
    slo,
  };
}

/** Prometheus exposition for the currently-firing alerts (consumed by Alertmanager). */
export function renderAlertMetrics(alerts) {
  const lines = [
    '# HELP semo0o_alert_firing 1 when an alert rule is currently firing.',
    '# TYPE semo0o_alert_firing gauge',
  ];
  if (!alerts.length) {
    lines.push('semo0o_alert_firing{id="none",severity="info"} 0');
    return `${lines.join('\n')}\n`;
  }
  for (const alert of alerts) {
    lines.push(`semo0o_alert_firing{id="${alert.id}",severity="${alert.severity}"} 1`);
  }
  return `${lines.join('\n')}\n`;
}
