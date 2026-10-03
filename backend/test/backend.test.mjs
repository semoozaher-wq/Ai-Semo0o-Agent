import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
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

test('backend registers users, creates tenant-scoped projects, queues code runs, and persists evidence', async () => {
  const fx = await fixture();
  try {
    const registered = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'owner@example.test', password: 'correct horse battery staple', tenantName: 'Tenant A' } });
    assert.equal(registered.status, 201);
    const token = registered.body.session.token;
    const project = await request(fx.base, '/projects', { method: 'POST', token, body: { name: 'Project A', rootPath: '/tmp/project-a' } });
    assert.equal(project.status, 201);
    const run = await request(fx.base, '/runs', { method: 'POST', token, body: { projectId: project.body.projectId, workspaceId: project.body.workspaceId, kind: 'code.run', language: 'javascript', source: 'console.log(42)' } });
    assert.equal(run.status, 202);
    fx.queue.start();
    for (let i = 0; i < 50; i += 1) { if (fx.db.get('SELECT status FROM runs WHERE id=?', run.body.runId)?.status === 'completed') break; await new Promise((resolve) => setTimeout(resolve, 5)); }
    const fetched = await request(fx.base, `/runs/${run.body.runId}`, { token });
    assert.equal(fetched.body.status, 'completed');
    assert.equal(fetched.body.evidence.length, 1);
  } finally { await fx.close(); }
});

test('backend enforces tenant isolation and dangerous approval transitions', async () => {
  const fx = await fixture();
  try {
    const a = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'a@example.test', password: 'correct horse battery staple', tenantName: 'A' } });
    const b = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'b@example.test', password: 'correct horse battery staple', tenantName: 'B' } });
    const project = await request(fx.base, '/projects', { method: 'POST', token: a.body.session.token, body: { name: 'Private', rootPath: '/tmp/private' } });
    const forbiddenRun = await request(fx.base, '/runs', { method: 'POST', token: b.body.session.token, body: { projectId: project.body.projectId, workspaceId: project.body.workspaceId, source: 'x', language: 'javascript' } });
    assert.equal(forbiddenRun.status, 404);
    const approved = await request(fx.base, '/runs', { method: 'POST', token: a.body.session.token, body: { projectId: project.body.projectId, workspaceId: project.body.workspaceId, source: 'x', language: 'javascript', requiresApproval: true } });
    assert.equal(approved.body.status, 'waiting_approval');
    const denied = await request(fx.base, `/runs/${approved.body.runId}/approval`, { method: 'POST', token: a.body.session.token, body: { decision: 'deny' } });
    assert.equal(denied.body.status, 'blocked');
    const crossRead = await request(fx.base, `/runs/${approved.body.runId}`, { token: b.body.session.token });
    assert.equal(crossRead.status, 404);
  } finally { await fx.close(); }
});
