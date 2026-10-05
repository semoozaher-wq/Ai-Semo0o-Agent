import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, id, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';
import { purgeTenant, runRetention } from '../ops/retention.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-retention-'));
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

// Build a tenant with rows that reference users via ON DELETE RESTRICT, which is
// exactly what makes a naive tenant delete fail.
function seedFullTenant(db, user, { createdAt = now() } = {}) {
  const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task'); const runId = id('run');
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, user.tenant_id, user.id, 'p', createdAt);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, '/tmp', createdAt);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, user.tenant_id, projectId, workspaceId, user.id, 'goal', 'completed', createdAt, createdAt);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, user.tenant_id, 'completed', JSON.stringify({ kind: 'agent.run' }), 1, createdAt, createdAt);
  db.run('INSERT INTO approvals(id,run_id,requested_by,capability,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)', id('approval'), runId, user.id, 'code.execute', 'allow', 'seed', createdAt);
  db.run('INSERT INTO messages(id,tenant_id,project_id,user_id,role,content,created_at) VALUES(?,?,?,?,?,?,?)', id('msg'), user.tenant_id, projectId, user.id, 'user', 'hi', createdAt);
  db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('evt'), runId, user.tenant_id, 'run.started', '{}', createdAt);
  db.run('INSERT INTO invitations(id,tenant_id,invited_by,email,role,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)', id('invite'), user.tenant_id, user.id, 'x@y.z', 'member', id('hash'), createdAt, createdAt);
  return { projectId, taskId, runId };
}

test('purgeTenant erases a full tenant without FK errors and leaves nothing behind', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'purge@retention.test', password: 'correct horse battery staple', tenantName: 'Purge' });
    seedFullTenant(fx.db, user);
    const counts = purgeTenant(fx.db, user.tenant_id);
    assert.ok(counts.projects >= 1);
    assert.ok(counts.users >= 1);
    assert.ok(counts.tenants >= 1);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', user.tenant_id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM users WHERE tenant_id=?', user.tenant_id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM projects WHERE tenant_id=?', user.tenant_id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tasks WHERE tenant_id=?', user.tenant_id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM runs WHERE tenant_id=?', user.tenant_id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM invitations WHERE tenant_id=?', user.tenant_id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM messages WHERE tenant_id=?', user.tenant_id).n, 0);
  } finally { await fx.close(); }
});

test('purgeTenant is tenant-isolated', async () => {
  const fx = await fixture();
  try {
    const a = createUser(fx.db, { email: 'a@retention.test', password: 'correct horse battery staple', tenantName: 'A' });
    const b = createUser(fx.db, { email: 'b@retention.test', password: 'correct horse battery staple', tenantName: 'B' });
    seedFullTenant(fx.db, a);
    seedFullTenant(fx.db, b);
    purgeTenant(fx.db, a.tenant_id);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM users WHERE tenant_id=?', b.tenant_id).n, 1);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM projects WHERE tenant_id=?', b.tenant_id).n, 1);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', b.tenant_id).n, 1);
  } finally { await fx.close(); }
});

test('runRetention prunes only aged operational rows', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'retain@retention.test', password: 'correct horse battery staple', tenantName: 'Retain' });
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const fresh = now();
    // Old session + old run event + old audit log.
    fx.db.run('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)', id('session'), user.id, id('hash'), old, old);
    fx.db.run('INSERT INTO audit_logs(id,tenant_id,action,metadata_json,created_at) VALUES(?,?,?,?,?)', id('audit'), user.tenant_id, 'old.action', '{}', old);
    // Fresh session + fresh audit log must survive.
    fx.db.run('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)', id('session'), user.id, id('hash'), new Date(Date.now() + 86_400_000).toISOString(), fresh);
    fx.db.run('INSERT INTO audit_logs(id,tenant_id,action,metadata_json,created_at) VALUES(?,?,?,?,?)', id('audit'), user.tenant_id, 'fresh.action', '{}', fresh);
    // An old queued email must NOT be pruned (only sent/failed age out).
    fx.db.run('INSERT INTO email_outbox(id,tenant_id,to_email,template,subject,body,status,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('email'), user.tenant_id, 'q@x.z', 'invitation', 's', 'b', 'queued', 0, old, old);
    fx.db.run('INSERT INTO email_outbox(id,tenant_id,to_email,template,subject,body,status,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('email'), user.tenant_id, 's@x.z', 'invitation', 's', 'b', 'sent', 1, old, old);

    const result = runRetention(fx.db, {});
    assert.ok(result.counts.expiredSessions >= 1);
    assert.ok(result.counts.auditLogs >= 1);
    assert.ok(result.counts.sentEmails >= 1);
    assert.equal(fx.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='old.action'").n, 0);
    assert.equal(fx.db.get("SELECT COUNT(*) AS n FROM audit_logs WHERE action='fresh.action'").n, 1);
    assert.equal(fx.db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE status='queued'").n, 1);
    assert.equal(fx.db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE status='sent'").n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?', fresh).n, 1);
  } finally { await fx.close(); }
});

test('DELETE /me purges the whole account (owner-only, email-confirmed) and revokes access', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'del@retention.test', password: 'correct horse battery staple', tenantName: 'Del' });
    seedFullTenant(fx.db, owner);
    const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'del@retention.test', password: 'correct horse battery staple' } });
    const token = login.body.session.token;

    // Wrong confirmation is rejected.
    assert.equal((await fx.request('/me', { method: 'DELETE', token, body: { confirmEmail: 'wrong@x.z' } })).status, 400);
    // Correct confirmation purges everything.
    const deleted = await fx.request('/me', { method: 'DELETE', token, body: { confirmEmail: 'del@retention.test' } });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.ok(deleted.body.purged.tenants >= 1);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', owner.tenant_id).n, 0);
    // The session token is gone, so subsequent calls are unauthorized.
    assert.equal((await fx.request('/org/members', { token })).status, 401);
  } finally { await fx.close(); }
});

test('POST /ops/retention/run is admin-gated and returns counts', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'ops@retention.test', password: 'correct horse battery staple', tenantName: 'Ops' });
    const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'ops@retention.test', password: 'correct horse battery staple' } });
    const token = login.body.session.token;
    const ok = await fx.request('/ops/retention/run', { method: 'POST', token });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.counts);
    fx.db.run("UPDATE users SET role='viewer' WHERE id=?", owner.id);
    assert.equal((await fx.request('/ops/retention/run', { method: 'POST', token })).status, 403);
  } finally { await fx.close(); }
});
