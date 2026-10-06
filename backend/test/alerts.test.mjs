import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, id, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';
import { ALERT_RULES, DEFAULT_THRESHOLDS, evaluateAlerts, renderAlertMetrics } from '../observability/alerts.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-alerts-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return {
    dir, db, queue, app, base, request,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

// Runs reference a task (which references a project + workspace), so seed the
// whole chain once and then drop N runs under it.
function seedRunContext(db, user) {
  const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task');
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, user.tenant_id, user.id, 'p', now());
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, '/tmp', now());
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, user.tenant_id, projectId, workspaceId, user.id, 'goal', 'completed', now(), now());
  return taskId;
}

function seedRun(db, user, taskId, { status = 'completed', createdAt = now() } = {}) {
  const runId = id('run');
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, user.tenant_id, status, JSON.stringify({ kind: 'agent.run' }), 1, createdAt, createdAt);
  return runId;
}

function seedToolCall(db, runId, { status = 'success', createdAt = now() } = {}) {
  db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,status,created_at) VALUES(?,?,?,?,?,?)', id('tool'), runId, 'code.run', '{}', status, createdAt);
}

test('an empty platform reports ok with no firing alerts', async () => {
  const fx = await fixture();
  try {
    const report = evaluateAlerts(fx.db, {});
    assert.equal(report.ok, true);
    assert.equal(report.firing.length, 0);
    assert.equal(report.highestSeverity, 'info');
    assert.equal(report.windowHours, 24);
    const text = renderAlertMetrics(report.firing);
    assert.match(text, /semo0o_alert_firing\{id="none",severity="info"\} 0/);
  } finally { await fx.close(); }
});

test('the run-success SLO alert is gated by a minimum sample size', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'slo@alerts.test', password: 'correct horse battery staple', tenantName: 'SLO' });
    const taskId = seedRunContext(fx.db, user);

    // 5 failures is below the 20-run minimum: no page.
    for (let i = 0; i < 5; i += 1) seedRun(fx.db, user, taskId, { status: 'failed' });
    assert.equal(evaluateAlerts(fx.db, {}).firing.some((a) => a.id === 'run_success_slo_breach'), false);

    // Cross the minimum with a bad ratio -> critical alert.
    for (let i = 0; i < 20; i += 1) seedRun(fx.db, user, taskId, { status: 'failed' });
    const report = evaluateAlerts(fx.db, {});
    const alert = report.firing.find((a) => a.id === 'run_success_slo_breach');
    assert.ok(alert, 'expected the run SLO alert to fire');
    assert.equal(alert.severity, 'critical');
    assert.equal(report.highestSeverity, 'critical');
    assert.equal(report.ok, false);
    assert.equal(alert.detail.totalRuns, 25);
  } finally { await fx.close(); }
});

test('the tool-success SLO alert fires as a warning once enough calls exist', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'tool@alerts.test', password: 'correct horse battery staple', tenantName: 'Tools' });
    const taskId = seedRunContext(fx.db, user);
    const runId = seedRun(fx.db, user, taskId, { status: 'completed' });
    for (let i = 0; i < 25; i += 1) seedToolCall(fx.db, runId, { status: 'error' });
    const report = evaluateAlerts(fx.db, {});
    const alert = report.firing.find((a) => a.id === 'tool_success_slo_breach');
    assert.ok(alert);
    assert.equal(alert.severity, 'warning');
  } finally { await fx.close(); }
});

test('queue backlog escalates from warning to critical at the threshold', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'queue@alerts.test', password: 'correct horse battery staple', tenantName: 'Queue' });
    const taskId = seedRunContext(fx.db, user);

    for (let i = 0; i < DEFAULT_THRESHOLDS.queueDepthWarning; i += 1) seedRun(fx.db, user, taskId, { status: 'queued' });
    let alert = evaluateAlerts(fx.db, {}).firing.find((a) => a.id === 'queue_backlog');
    assert.ok(alert);
    assert.equal(alert.severity, 'warning');

    for (let i = DEFAULT_THRESHOLDS.queueDepthWarning; i < DEFAULT_THRESHOLDS.queueDepthCritical; i += 1) seedRun(fx.db, user, taskId, { status: 'queued' });
    alert = evaluateAlerts(fx.db, {}).firing.find((a) => a.id === 'queue_backlog');
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.detail.queueDepth, DEFAULT_THRESHOLDS.queueDepthCritical);
  } finally { await fx.close(); }
});

test('email delivery failures and self-improve regressions surface as alerts', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'mail@alerts.test', password: 'correct horse battery staple', tenantName: 'Mail' });
    const ts = now();
    fx.db.run('INSERT INTO email_outbox(id,tenant_id,to_email,template,subject,body,status,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('email'), user.tenant_id, 'x@y.z', 'invitation', 's', 'b', 'failed', 1, ts, ts);
    let report = evaluateAlerts(fx.db, {});
    let alert = report.firing.find((a) => a.id === 'email_delivery_failures');
    assert.ok(alert);
    assert.equal(alert.severity, 'warning');

    for (let i = 0; i < DEFAULT_THRESHOLDS.failedEmailsCritical; i += 1) {
      fx.db.run('INSERT INTO email_outbox(id,tenant_id,to_email,template,subject,body,status,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('email'), user.tenant_id, 'x@y.z', 'invitation', 's', 'b', 'failed', 1, ts, ts);
    }
    alert = evaluateAlerts(fx.db, {}).firing.find((a) => a.id === 'email_delivery_failures');
    assert.equal(alert.severity, 'critical');

    fx.db.run("INSERT INTO self_improve_proposals(id,tenant_id,scope,signature,category,kind,status,severity,title,rationale,patch_json,evidence_json,occurrences,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id('prop'), user.tenant_id, 'tenant', 'sig', 'reliability', 'tool_disable', 'regressed', 'high', 't', 'r', '{}', '{}', 1, ts, ts);
    report = evaluateAlerts(fx.db, {});
    assert.ok(report.firing.some((a) => a.id === 'self_improve_regression'));
  } finally { await fx.close(); }
});

test('memory pressure honours custom thresholds and renderAlertMetrics labels firing alerts', async () => {
  const fx = await fixture();
  try {
    // Force a warning by making the warning threshold zero and the critical huge.
    const report = evaluateAlerts(fx.db, { thresholds: { ...DEFAULT_THRESHOLDS, rssWarningBytes: 0, rssCriticalBytes: Number.MAX_SAFE_INTEGER } });
    const alert = report.firing.find((a) => a.id === 'memory_pressure');
    assert.ok(alert);
    assert.equal(alert.severity, 'warning');

    const text = renderAlertMetrics(report.firing);
    assert.match(text, /semo0o_alert_firing\{id="memory_pressure",severity="warning"\} 1/);
  } finally { await fx.close(); }
});

test('every alert rule is well-formed and uniquely addressable by severity', async () => {
  for (const rule of ALERT_RULES) {
    assert.equal(typeof rule.id, 'string');
    assert.ok(['info', 'warning', 'critical'].includes(rule.severity));
    assert.equal(typeof rule.evaluate, 'function');
    assert.equal(typeof rule.summary, 'string');
  }
});

test('GET /ops/alerts is owner/admin-only and returns the firing set', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'ops@alerts.test', password: 'correct horse battery staple', tenantName: 'Ops' });
    const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'ops@alerts.test', password: 'correct horse battery staple' } });
    const token = login.body.session.token;

    const ok = await fx.request('/ops/alerts', { token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.ok(Array.isArray(ok.body.firing));
    assert.ok(ok.body.slo);
    assert.equal(ok.body.metrics, undefined, 'the metrics blob must not leak through the alert view');

    // Demote to viewer -> forbidden.
    fx.db.run("UPDATE users SET role='viewer' WHERE id=?", owner.id);
    assert.equal((await fx.request('/ops/alerts', { token })).status, 403);
  } finally { await fx.close(); }
});
