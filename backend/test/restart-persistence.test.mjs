import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';

/**
 * End-to-end durability across a real process restart (Point 3 of the
 * remediation: "SQLite and tasks must survive a restart").
 *
 * Unlike the store-level tests, this drives the actual HTTP API, closes the
 * database AND the server, then boots a *brand-new* Database over the SAME file
 * (exactly what a redeploy does) and re-checks every surface with the SAME
 * session token:
 *
 *   - the session token still authenticates (hash-at-rest is durable);
 *   - conversations and their messages are still readable;
 *   - uploaded attachment metadata AND bytes come back byte-for-byte;
 *   - projects/workspaces are still present;
 *   - the queued task/run is still there and still parked in waiting_approval;
 *   - an idempotent re-submit still returns the original run (no duplicate).
 */

function mockLlm() {
  return {
    status: () => [{ id: 'test', model: 'test', configured: true }],
    async complete() { return { provider: 'test', text: 'ok', usage: { totalTokens: 1 } }; },
    async *stream() { yield { type: 'token', text: 'ok' }; yield { type: 'done', usage: { totalTokens: 1 }, provider: 'test' }; },
  };
}

async function boot(dbFile) {
  const db = new Database(dbFile);
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm: mockLlm() });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const isJson = contentType.includes('json');
    return {
      status: response.status,
      contentType,
      headers: response.headers,
      body: isJson ? await response.json().catch(() => ({})) : await response.arrayBuffer(),
    };
  };
  const stop = async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); };
  return { db, queue, app, base, request, stop };
}

test('every durable surface survives a real close/reopen of the same SQLite file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-restart-'));
  const dbFile = path.join(dir, 'agent.sqlite');
  const workspaceRoot = path.join(dir, 'workspaces');
  try {
    // ---- Process #1: create the data -------------------------------------
    const first = await boot(dbFile);
    const registered = await first.request('/auth/register', { method: 'POST', body: { email: 'durable@restart.test', password: 'correct horse battery staple', tenantName: 'Durable Co' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const { tenantId, id: userId } = registered.body.user;

    const project = await first.request('/projects', { method: 'POST', token, body: { name: 'Durable', rootPath: path.join(workspaceRoot, 'p1') } });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const { projectId, workspaceId } = project.body;

    const conversation = await first.request('/conversations', { method: 'POST', token, body: { title: 'Durable thread', projectId } });
    assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
    const conversationId = conversation.body.id;
    const appended = await first.request(`/conversations/${conversationId}/messages`, { method: 'POST', token, body: { content: 'remember me' } });
    assert.equal(appended.status, 201);

    const bytes = Buffer.from('durable attachment payload');
    const uploaded = await first.request('/attachments', { method: 'POST', token, body: { name: 'note.txt', mimeType: 'text/plain', dataBase64: bytes.toString('base64'), conversationId } });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const attachmentId = uploaded.body.id;

    // Park an agent run (requiresApproval) so it is durable but never executes.
    const run = await first.request('/runs', { method: 'POST', token, body: { kind: 'agent.run', goal: 'durable goal', projectId, workspaceId, requiresApproval: true, idempotencyKey: 'durable-key-1' } });
    assert.equal(run.status, 202, JSON.stringify(run.body));
    const runId = run.body.runId;
    const taskId = run.body.taskId;

    await first.stop();

    // ---- Process #2: a brand-new Database over the SAME file -------------
    const second = await boot(dbFile);
    try {
      // The session token still authenticates after restart.
      const me = await second.request('/me', { token });
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body.user.id, userId);
      assert.equal(me.body.user.tenantId, tenantId);

      // Conversation + message survived.
      const conv = await second.request(`/conversations/${conversationId}`, { token });
      assert.equal(conv.status, 200);
      assert.equal(conv.body.title, 'Durable thread');
      assert.ok(conv.body.messages.some((m) => m.content === 'remember me'));

      // Attachment metadata + bytes survived, byte-for-byte.
      const meta = await second.request(`/attachments/${attachmentId}`, { token });
      assert.equal(meta.status, 200);
      assert.equal(meta.body.name, 'note.txt');
      const content = await second.request(`/attachments/${attachmentId}/content`, { token });
      assert.equal(content.status, 200);
      assert.ok(Buffer.compare(Buffer.from(content.body), bytes) === 0, 'attachment bytes must match after restart');

      // Project survived.
      const proj = await second.request(`/projects/${projectId}`, { token });
      assert.equal(proj.status, 200);
      assert.equal(proj.body.id, projectId);

      // Task + run survived and are still parked.
      const runView = await second.request(`/runs/${runId}`, { token });
      assert.equal(runView.status, 200, JSON.stringify(runView.body));
      assert.equal(runView.body.status, 'waiting_approval');
      const taskRow = second.db.get('SELECT * FROM tasks WHERE id=? AND tenant_id=?', taskId, tenantId);
      assert.ok(taskRow, 'the task row must persist');
      assert.equal(taskRow.status, 'waiting_approval');

      // Idempotent re-submit returns the ORIGINAL run, not a duplicate.
      const resubmit = await second.request('/runs', { method: 'POST', token, body: { kind: 'agent.run', goal: 'durable goal', projectId, workspaceId, requiresApproval: true, idempotencyKey: 'durable-key-1' } });
      assert.equal(resubmit.status, 202);
      assert.equal(resubmit.body.runId, runId);
      assert.equal(resubmit.body.idempotent, true);
      const runCount = second.db.get('SELECT COUNT(*) AS n FROM runs WHERE tenant_id=?', tenantId).n;
      assert.equal(runCount, 1, 'idempotency must not create a duplicate run across restart');
    } finally { await second.stop(); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a run left mid-flight by a crash is reconciled, never left running forever', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-restart-crash-'));
  const dbFile = path.join(dir, 'agent.sqlite');
  try {
    // Simulate a process that died holding a lease: a `running` row whose lease
    // is already in the past and whose owning worker will never come back.
    const db1 = new Database(dbFile);
    db1.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', 'tenant_crash', 'Crash Co', new Date().toISOString());
    db1.run('INSERT INTO users(id,tenant_id,email,role,password_hash,created_at) VALUES(?,?,?,?,?,?)', 'user_crash', 'tenant_crash', 'crash@restart.test', 'owner', 'x', new Date().toISOString());
    db1.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', 'proj_crash', 'tenant_crash', 'user_crash', 'P', new Date().toISOString());
    db1.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', 'ws_crash', 'proj_crash', path.join(dir, 'ws'), new Date().toISOString());
    db1.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', 'task_crash', 'tenant_crash', 'proj_crash', 'ws_crash', 'user_crash', 'g', 'running', new Date().toISOString(), new Date().toISOString());
    db1.run("INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,worker_id,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", 'run_crash', 'task_crash', 'tenant_crash', 'running', '{}', 1, 'dead_worker', new Date(Date.now() - 60_000).toISOString(), new Date().toISOString(), new Date().toISOString());
    db1.close();

    // A fresh process boots over the same file and sweeps orphaned leases.
    const db2 = new Database(dbFile);
    const queue = new RunQueue(db2, { pollMs: 5 });
    const summary = await queue.recover();
    assert.ok(summary, 'recover() must return a reconciliation summary');
    const row = db2.get('SELECT status FROM runs WHERE id=?', 'run_crash');
    assert.notEqual(row.status, 'running', 'a dead-lease run must never remain running after recovery');
    assert.ok(['queued', 'failed'].includes(row.status), `expected queued/failed, got ${row.status}`);
    queue.stop();
    db2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
