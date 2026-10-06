#!/usr/bin/env node
/**
 * Production Trial — Self-Improvement pipeline, end-to-end.
 *
 * This is a *live* trial (not a unit test): it boots the real HTTP server, the
 * real SQLite-backed RunQueue, the real auth/tenant stack, seeds real failure
 * telemetry into the database, and then drives the whole self-improvement
 * lifecycle exclusively through the public REST API:
 *
 *   signals -> analyze -> proposals -> approve (apply) -> monitor -> rollback
 *
 * It also proves the safety guarantees that make self-improvement safe to run in
 * production: RBAC (only owner/admin may approve), tenant isolation (a tenant
 * can never see or act on another tenant's proposal), and fail-closed rollback
 * (a recurrence after apply is rolled back automatically).
 *
 * Exit code 0 = the pipeline works and every guarantee held.
 * Exit code 1 = a guarantee failed; the failing check is printed.
 *
 * Usage: node --experimental-sqlite scripts/production-trial.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Database, id, now } from '../backend/db/client.mjs';
import { createApp } from '../backend/server.mjs';
import { RunQueue } from '../backend/queue/queue.mjs';
import { createUser } from '../backend/auth/security.mjs';

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`  \u2717 ${name}\n      ${error.message}`);
  }
}

async function boot() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-trial-'));
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

/** Seed a completed task/run plus a failed tool call so the engine has a real signal. */
function seedFailure(db, { tenantId, userId, toolId, error }) {
  const timestamp = now();
  const projectId = id('project'); const workspaceId = id('workspace');
  const taskId = id('task'); const runId = id('run');
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'trial', timestamp);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, '/tmp', timestamp);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'trial goal', 'failed', timestamp, timestamp);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'failed', JSON.stringify({ kind: 'agent.run' }), 1, timestamp, timestamp);
  db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,output_json,status,created_at) VALUES(?,?,?,?,?,?,?)', id('tool'), runId, toolId, '{}', JSON.stringify({ ok: false, error }), 'failed', timestamp);
  return runId;
}

async function main() {
  console.log('\n=== Semo0o Production Trial: Self-Improvement pipeline ===\n');
  const fx = await boot();
  try {
    const owner = createUser(fx.db, { email: 'trial-owner@semo.test', password: 'correct horse battery staple', tenantName: 'TrialOwner' });
    const other = createUser(fx.db, { email: 'trial-other@semo.test', password: 'correct horse battery staple', tenantName: 'TrialOther' });

    // Real failure telemetry: the planner keeps choosing a tool whose connector
    // is not configured server-side (the classic connector_unconfigured signal).
    seedFailure(fx.db, { tenantId: owner.tenant_id, userId: owner.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    seedFailure(fx.db, { tenantId: owner.tenant_id, userId: owner.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });

    const ownerLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'trial-owner@semo.test', password: 'correct horse battery staple' } });
    const ownerToken = ownerLogin.body.session.token;
    const otherLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'trial-other@semo.test', password: 'correct horse battery staple' } });
    const otherToken = otherLogin.body.session.token;
    check('auth: owner + second tenant can log in', () => { assert.ok(ownerToken); assert.ok(otherToken); });

    // 1) DETECT — read signals from real telemetry.
    const signals = await fx.request('/self-improve/signals', { token: ownerToken });
    check('detect: /self-improve/signals returns the seeded connector_unconfigured signal', () => {
      assert.equal(signals.status, 200);
      const sig = signals.body.signals.find((s) => s.signature === 'connector_unconfigured:image.generate');
      assert.ok(sig, 'expected connector_unconfigured:image.generate');
      assert.equal(sig.occurrences, 2);
    });

    // 2) ANALYZE — plan a bounded remediation and store a proposal.
    const analyzed = await fx.request('/self-improve/analyze', { method: 'POST', token: ownerToken, body: { minOccurrences: 2 } });
    const proposalId = analyzed.body?.proposals?.[0]?.id;
    check('analyze: /self-improve/analyze creates a bounded tool_disable proposal', () => {
      assert.equal(analyzed.status, 200);
      assert.ok(proposalId, 'expected a proposal id');
      const p = analyzed.body.proposals[0];
      assert.equal(p.kind, 'tool_disable');
      assert.equal(p.patch.toolId, 'image.generate');
      assert.equal(p.status, 'proposed');
    });

    // 3) TENANT ISOLATION — the other tenant must not see the proposal.
    const otherList = await fx.request('/self-improve/proposals', { token: otherToken });
    check('isolation: second tenant sees zero proposals', () => {
      assert.equal(otherList.status, 200);
      assert.equal(otherList.body.proposals.length, 0);
    });
    const otherApprove = await fx.request(`/self-improve/proposals/${proposalId}/approve`, { method: 'POST', token: otherToken });
    check('isolation: second tenant cannot approve another tenant\'s proposal (404)', () => {
      assert.equal(otherApprove.status, 404);
    });

    // 4) RBAC — a member cannot approve.
    fx.db.run("UPDATE users SET role='member' WHERE id=?", owner.id);
    const memberApprove = await fx.request(`/self-improve/proposals/${proposalId}/approve`, { method: 'POST', token: ownerToken });
    check('rbac: member cannot approve a proposal (403)', () => {
      assert.equal(memberApprove.status, 403);
    });
    fx.db.run("UPDATE users SET role='owner' WHERE id=?", owner.id);

    // 5) APPLY — owner approves; the override becomes active.
    const approved = await fx.request(`/self-improve/proposals/${proposalId}/approve`, { method: 'POST', token: ownerToken });
    check('apply: owner approve applies the override (status=applied)', () => {
      assert.equal(approved.status, 200);
      assert.equal(approved.body.proposal.status, 'applied');
    });

    // 6) MONITOR — a fresh recurrence after apply triggers automatic rollback.
    seedFailure(fx.db, { tenantId: owner.tenant_id, userId: owner.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    const monitored = await fx.request('/self-improve/monitor', { method: 'POST', token: ownerToken });
    check('monitor: recurrence after apply auto-rolls back the remediation', () => {
      assert.equal(monitored.status, 200);
      assert.equal(monitored.body.rolledBack.length, 1);
      assert.equal(monitored.body.rolledBack[0].status, 'regressed');
    });

    // 7) HISTORY — the full lifecycle is auditable.
    const history = await fx.request('/self-improve/history', { token: ownerToken });
    check('history: /self-improve/history records detect/verify/deploy/rollback phases', () => {
      assert.equal(history.status, 200);
      const phases = new Set(history.body.events.map((e) => e.phase));
      for (const phase of ['detect', 'verify', 'deploy', 'rollback']) assert.ok(phases.has(phase), `missing phase ${phase}`);
    });

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== Trial result: ${results.length - failed.length}/${results.length} checks passed ===\n`);
    if (failed.length) {
      console.log('FAILED checks:');
      for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
      process.exitCode = 1;
    } else {
      console.log('PRODUCTION TRIAL OK — self-improvement pipeline is live and fail-closed.\n');
    }
  } finally {
    await fx.close();
  }
}

main().catch((error) => {
  console.error('PRODUCTION TRIAL CRASHED:', error);
  process.exitCode = 1;
});
