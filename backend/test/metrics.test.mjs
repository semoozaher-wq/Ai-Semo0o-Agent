import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, id, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';
import { collectMetrics, computeSlo, isMetricsAuthorized, renderPrometheus } from '../observability/metrics.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-metrics-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    dir, db, queue, app, base,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

function seedRun(db, { tenantId, userId, status, toolStatuses = [] }) {
  const timestamp = now();
  const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task'); const runId = id('run');
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'm', timestamp);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, '/tmp', timestamp);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'goal', status, timestamp, timestamp);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, status, JSON.stringify({ kind: 'agent.run' }), 1, timestamp, timestamp);
  for (const toolStatus of toolStatuses) {
    db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,output_json,status,created_at) VALUES(?,?,?,?,?,?,?)', id('tool'), runId, 'files.read', '{}', '{}', toolStatus, timestamp);
  }
  return runId;
}

test('collectMetrics and computeSlo derive real numbers from durable rows', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'metrics@obs.test', password: 'correct horse battery staple', tenantName: 'Obs' });
    seedRun(fx.db, { tenantId: user.tenant_id, userId: user.id, status: 'completed', toolStatuses: ['success', 'success'] });
    seedRun(fx.db, { tenantId: user.tenant_id, userId: user.id, status: 'completed_with_warnings', toolStatuses: ['success'] });
    seedRun(fx.db, { tenantId: user.tenant_id, userId: user.id, status: 'failed', toolStatuses: ['failed'] });
    seedRun(fx.db, { tenantId: user.tenant_id, userId: user.id, status: 'queued' });

    const metrics = collectMetrics(fx.db, { windowHours: 24 });
    assert.equal(metrics.runs.byStatus.completed, 1);
    assert.equal(metrics.runs.byStatus.failed, 1);
    assert.equal(metrics.runs.byStatus.queued, 1);
    assert.equal(metrics.queueDepth, 1);
    assert.equal(metrics.toolCalls.byStatus.success, 3);
    assert.equal(metrics.toolCalls.byStatus.failed, 1);
    assert.equal(metrics.tenants, 1);
    assert.equal(metrics.users, 1);
    assert.ok(metrics.process.uptimeSeconds >= 0);

    const slo = computeSlo(fx.db, { windowHours: 24 });
    // 2 successes out of 3 terminal runs.
    assert.equal(slo.totalRuns, 3);
    assert.ok(Math.abs(slo.runSuccessRatio - 2 / 3) < 1e-9);
    assert.equal(slo.runSuccessMet, false, '2/3 is below the 0.95 target');
    // 3 successes out of 4 tool calls.
    assert.ok(Math.abs(slo.toolSuccessRatio - 3 / 4) < 1e-9);
    assert.equal(slo.toolSuccessMet, false);
  } finally { await fx.close(); }
});

test('computeSlo treats an empty window as healthy (ratio 1)', async () => {
  const fx = await fixture();
  try {
    const slo = computeSlo(fx.db, { windowHours: 24 });
    assert.equal(slo.runSuccessRatio, 1);
    assert.equal(slo.toolSuccessRatio, 1);
    assert.equal(slo.runSuccessMet, true);
    assert.equal(slo.totalRuns, 0);
  } finally { await fx.close(); }
});

test('renderPrometheus emits valid exposition text with SLO gauges', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'render@obs.test', password: 'correct horse battery staple', tenantName: 'Render' });
    seedRun(fx.db, { tenantId: user.tenant_id, userId: user.id, status: 'completed', toolStatuses: ['success'] });
    const text = renderPrometheus(collectMetrics(fx.db, { windowHours: 24 }), computeSlo(fx.db, { windowHours: 24 }));
    assert.match(text, /# TYPE semo0o_runs_total gauge/);
    assert.match(text, /semo0o_runs_total\{status="completed"\} 1/);
    assert.match(text, /semo0o_slo_run_success_ratio 1/);
    assert.match(text, /semo0o_slo_run_success_met 1/);
    assert.match(text, /semo0o_tenants_total 1/);
    assert.ok(text.endsWith('\n'));
    // Every non-comment line must be "name value" or "name{labels} value".
    for (const line of text.trim().split('\n')) {
      if (line.startsWith('#')) continue;
      assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d+(\.\d+)?$/);
    }
  } finally { await fx.close(); }
});

test('isMetricsAuthorized allows loopback and a matching token, denies everything else', () => {
  assert.equal(isMetricsAuthorized({ remoteAddress: '127.0.0.1' }), true);
  assert.equal(isMetricsAuthorized({ remoteAddress: '::1' }), true);
  assert.equal(isMetricsAuthorized({ remoteAddress: '::ffff:127.0.0.1' }), true);
  assert.equal(isMetricsAuthorized({ remoteAddress: '10.0.0.5' }), false);
  assert.equal(isMetricsAuthorized({ remoteAddress: '10.0.0.5', token: 'secret', expectedToken: 'secret' }), true);
  assert.equal(isMetricsAuthorized({ remoteAddress: '10.0.0.5', token: 'wrong', expectedToken: 'secret' }), false);
  assert.equal(isMetricsAuthorized({ remoteAddress: '10.0.0.5', token: 'secret', expectedToken: '' }), false);
});

test('GET /metrics serves Prometheus text to a loopback caller', async () => {
  const fx = await fixture();
  try {
    const response = await fetch(`${fx.base}/metrics`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/plain/);
    const text = await response.text();
    assert.match(text, /semo0o_runs_total/);
    assert.match(text, /semo0o_slo_tool_success_ratio/);
  } finally { await fx.close(); }
});
