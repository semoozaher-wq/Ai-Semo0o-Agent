import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createSession, createUser } from '../auth/security.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-backend-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, codeRunner: async ({ run, payload }) => {
    const evidence = { ok: true, isolated: true, network: 'none', stdout: `${payload.source}\n`, stderr: '', exitCode: 0, durationMs: 1 };
    db.run('INSERT INTO evidence(id,run_id,kind,payload_json,sha256,created_at) VALUES(?,?,?,?,?,?)', `ev_${run.id}`, run.id, 'code.run', JSON.stringify(evidence), 'test-hash', new Date().toISOString());
    return { status: 'completed', ...evidence };
  } });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return { dir, db, queue, app, base, async close() { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, { headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
  return { status: response.status, body: await response.json() };
}

test('backend requires approval before dangerous code runs', async () => {
  const fx = await fixture();
  try {
    const registered = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'owner@example.test', password: 'correct horse battery staple', tenantName: 'Tenant A' } });
    assert.equal(registered.status, 201);
    const token = registered.body.session.token;
    const project = await request(fx.base, '/projects', { method: 'POST', token, body: { name: 'Project A', rootPath: '/tmp/project-a' } });
    assert.equal(project.status, 201);
    const run = await request(fx.base, '/runs', { method: 'POST', token, body: { projectId: project.body.projectId, workspaceId: project.body.workspaceId, kind: 'code.run', language: 'javascript', source: 'console.log(42)' } });
    assert.equal(run.status, 202);
    const fetched = await request(fx.base, `/runs/${run.body.runId}`, { token });
    assert.equal(fetched.body.status, 'waiting_approval');
    assert.equal(fetched.body.evidence.length, 0);
  } finally { await fx.close(); }
});

test('backend enforces tenant isolation and dangerous approval transitions', async () => {
  const fx = await fixture();
  try {
    const a = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'a@example.test', password: 'correct horse battery staple', tenantName: 'A' } });
    const b = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'b@example.test', password: 'correct horse battery staple', tenantName: 'B' } });
    const admin = createUser(fx.db, { email: 'admin@example.test', password: 'correct horse battery staple', tenantName: 'Temporary' });
    fx.db.run('UPDATE users SET tenant_id=?, role=? WHERE id=?', a.body.user.tenantId, 'admin', admin.id);
    const adminToken = createSession(fx.db, admin.id).token;
    const project = await request(fx.base, '/projects', { method: 'POST', token: a.body.session.token, body: { name: 'Private', rootPath: '/tmp/private' } });
    const forbiddenRun = await request(fx.base, '/runs', { method: 'POST', token: b.body.session.token, body: { projectId: project.body.projectId, workspaceId: project.body.workspaceId, source: 'x', language: 'javascript' } });
    assert.equal(forbiddenRun.status, 404);
    const approved = await request(fx.base, '/runs', { method: 'POST', token: a.body.session.token, body: { projectId: project.body.projectId, workspaceId: project.body.workspaceId, source: 'x', language: 'javascript', requiresApproval: true } });
    assert.equal(approved.body.status, 'waiting_approval');
    const denied = await request(fx.base, `/runs/${approved.body.runId}/approval`, { method: 'POST', token: adminToken, body: { decision: 'deny' } });
    assert.equal(denied.body.status, 'blocked');
    const crossRead = await request(fx.base, `/runs/${approved.body.runId}`, { token: b.body.session.token });
    assert.equal(crossRead.status, 404);
  } finally { await fx.close(); }
});

test('chat mode answers through LLM without creating an agent run', async () => {
  const fx = await fixture();
  const chatLlm = { status: () => [{ id: 'test', model: 'test', configured: true }], async complete() { return { provider: 'test', text: 'رد محادثة مباشر', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }; } };
  fx.app.server.close(); fx.db.close(); fx.queue.stop();
  const dir = fx.dir;
  const db = new Database(path.join(dir, 'chat.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm: chatLlm });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const registered = await request(base, '/auth/register', { method: 'POST', body: { email: 'chat@example.test', password: 'correct horse battery staple', tenantName: 'Chat' } });
    const response = await request(base, '/chat', { method: 'POST', token: registered.body.session.token, body: { message: 'مرحبا' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.text, 'رد محادثة مباشر');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM runs').count, 0);
  } finally { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('project creation fails closed when no workspace root is provided', async () => {
  const fx = await fixture();
  try {
    const registered = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'root-required@example.test', password: 'correct horse battery staple', tenantName: 'Root' } });
    const response = await request(fx.base, '/projects', { method: 'POST', token: registered.body.session.token, body: { name: 'Unsafe project' } });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'WORKSPACE_ROOT_REQUIRED');
  } finally { await fx.close(); }
});

test('runs are idempotent per tenant and key', async () => {
  const fx = await fixture();
  try {
    const registered = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'idempotent@example.test', password: 'correct horse battery staple', tenantName: 'Idempotent' } });
    const token = registered.body.session.token;
    const project = await request(fx.base, '/projects', { method: 'POST', token, body: { name: 'Idempotent Project', rootPath: '/tmp/idempotent-project' } });
    const body = { projectId: project.body.projectId, workspaceId: project.body.workspaceId, kind: 'agent.run', goal: 'read one file' };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'request-001' };
    const first = await request(fx.base, '/runs', { method: 'POST', headers, body });
    const second = await request(fx.base, '/runs', { method: 'POST', headers, body });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(second.body.idempotent, true);
    assert.equal(second.body.runId, first.body.runId);
    assert.equal(fx.db.get('SELECT COUNT(*) AS count FROM runs').count, 1);
  } finally { await fx.close(); }
});

test('usage endpoint reports tenant-scoped series, totals, and quota', async () => {
  const fx = await fixture();
  try {
    const registered = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'usage@example.test', password: 'correct horse battery staple', tenantName: 'Usage' } });
    const token = registered.body.session.token;
    const tenantId = registered.body.user.tenantId;
    const other = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'other-usage@example.test', password: 'correct horse battery staple', tenantName: 'Other' } });

    const today = new Date().toISOString();
    const project = await request(fx.base, '/projects', { method: 'POST', token, body: { name: 'Usage Project', rootPath: '/tmp/usage-project' } });
    fx.db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', 'task_usage_1', tenantId, project.body.projectId, project.body.workspaceId, registered.body.user.id, 'usage', 'completed', today, today);
    fx.db.run('INSERT INTO runs(id,tenant_id,task_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', 'run_usage_1', tenantId, 'task_usage_1', 'completed', '{}', today, today);
    fx.db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', 'usage_1', 'run_usage_1', tenantId, 'openai', 'gpt-5', 100, 50, 150, 0.012, today);
    fx.db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', 'usage_other', 'run_usage_1', other.body.user.tenantId, 'openai', 'gpt-5', 999, 999, 1998, 9.99, today);

    const usage = await request(fx.base, '/usage?days=30', { token });
    assert.equal(usage.status, 200);
    assert.equal(usage.body.totals.tokens, 150);
    assert.equal(usage.body.totals.runs, 1);
    assert.ok(Math.abs(usage.body.totals.costUsd - 0.012) < 1e-9);
    assert.equal(usage.body.daily.length, 1);
    assert.equal(usage.body.daily[0].tokens, 150);
    assert.equal(usage.body.quota.monthly_tokens, 100000);
    assert.equal(usage.body.period, new Date().toISOString().slice(0, 7));

    const clamped = await request(fx.base, '/usage?days=9999', { token });
    assert.equal(clamped.body.days, 90);
    const unauthenticated = await fetch(`${fx.base}/usage`);
    assert.equal(unauthenticated.status, 401);
  } finally { await fx.close(); }
});

test('auth lifecycle revokes sessions on logout and cascades account deletion', async () => {
  const fx = await fixture();
  try {
    const registered = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'lifecycle@example.test', password: 'correct horse battery staple', tenantName: 'Lifecycle' } });
    const token = registered.body.session.token;
    const tenantId = registered.body.user.tenantId;
    await request(fx.base, '/projects', { method: 'POST', token, body: { name: 'Keep', rootPath: '/tmp/lifecycle-project' } });

    const exported = await request(fx.base, '/me/export', { token });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.user.tenantId, tenantId);
    assert.equal(exported.body.projects.length, 1);

    const loggedOut = await request(fx.base, '/auth/logout', { method: 'POST', token });
    assert.equal(loggedOut.status, 200);
    const afterLogout = await request(fx.base, '/me/export', { token });
    assert.equal(afterLogout.status, 401);

    const login = await request(fx.base, '/auth/login', { method: 'POST', body: { email: 'lifecycle@example.test', password: 'correct horse battery staple' } });
    const freshToken = login.body.session.token;
    const wrongConfirm = await request(fx.base, '/me', { method: 'DELETE', token: freshToken, body: { confirmEmail: 'wrong@example.test' } });
    assert.equal(wrongConfirm.status, 400);
    const deleted = await request(fx.base, '/me', { method: 'DELETE', token: freshToken, body: { confirmEmail: 'lifecycle@example.test' } });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(fx.db.get('SELECT COUNT(*) AS count FROM tenants WHERE id=?', tenantId).count, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS count FROM projects WHERE tenant_id=?', tenantId).count, 0);
  } finally { await fx.close(); }
});
