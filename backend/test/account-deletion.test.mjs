import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, id, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser, passwordHash } from '../auth/security.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-deletion-'));
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

// Add a second member to an existing tenant (createUser always makes a fresh
// tenant, so multi-member setups are built by hand).
function addMember(db, tenantId, { email, role = 'member', password = 'correct horse battery staple' }) {
  const userId = id('user');
  const createdAt = now();
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, email.toLowerCase(), passwordHash(password), role, createdAt);
  db.run('INSERT INTO tenant_members(tenant_id,user_id,role,status,created_at) VALUES(?,?,?,?,?)', tenantId, userId, role, 'active', createdAt);
  return db.get('SELECT id,tenant_id,email,role FROM users WHERE id=?', userId);
}

async function login(fx, email, password = 'correct horse battery staple') {
  const response = await fx.request('/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(response.status, 200, `login failed for ${email}: ${JSON.stringify(response.body)}`);
  return response.body.session.token;
}

test('a non-owner member can delete their own account (previously always 403)', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'owner@deletion.test', password: 'correct horse battery staple', tenantName: 'Org' });
    const member = addMember(fx.db, owner.tenant_id, { email: 'member@deletion.test' });
    // The member owns a project that must survive by being reassigned.
    const projectId = id('project');
    fx.db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, owner.tenant_id, member.id, 'member project', now());

    const token = await login(fx, 'member@deletion.test');
    const deleted = await fx.request('/me', { method: 'DELETE', token, body: { confirmEmail: 'member@deletion.test' } });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(deleted.body.scope, 'self');
    assert.equal(deleted.body.counts.projectsReassigned, 1);

    // Member identity is gone; tenant + owner survive; project was reassigned.
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM users WHERE id=?', member.id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenant_members WHERE user_id=?', member.id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', owner.tenant_id).n, 1);
    assert.equal(fx.db.get('SELECT owner_id FROM projects WHERE id=?', projectId).owner_id, owner.id);
    // Their session is revoked, so the token no longer authenticates.
    assert.equal((await fx.request('/me/export', { token })).status, 401);
  } finally { await fx.close(); }
});

test('the last owner with other members must transfer ownership (409) or is refused', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'boss@deletion.test', password: 'correct horse battery staple', tenantName: 'Org' });
    const member = addMember(fx.db, owner.tenant_id, { email: 'member@deletion.test' });
    const token = await login(fx, 'boss@deletion.test');

    // No successor named -> never orphan the tenant.
    const refused = await fx.request('/me', { method: 'DELETE', token, body: { confirmEmail: 'boss@deletion.test' } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'ORG_OWNER_TRANSFER_REQUIRED');
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM users WHERE id=?', owner.id).n, 1);

    // Naming a successor succeeds and promotes them to owner.
    const transferred = await fx.request('/me', { method: 'DELETE', token, body: { confirmEmail: 'boss@deletion.test', transferOwnershipTo: member.id } });
    assert.equal(transferred.status, 200);
    assert.equal(transferred.body.scope, 'self');
    assert.equal(transferred.body.counts.ownershipTransferred, 1);
    assert.equal(fx.db.get('SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?', owner.tenant_id, member.id).role, 'owner');
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM users WHERE id=?', owner.id).n, 0);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', owner.tenant_id).n, 1);
  } finally { await fx.close(); }
});

test('a sole owner deleting their account purges the whole tenant', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'solo@deletion.test', password: 'correct horse battery staple', tenantName: 'Solo' });
    const token = await login(fx, 'solo@deletion.test');
    const deleted = await fx.request('/me', { method: 'DELETE', token, body: { confirmEmail: 'solo@deletion.test' } });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.scope, 'tenant');
    assert.ok(deleted.body.purged.tenants >= 1);
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', owner.tenant_id).n, 0);
  } finally { await fx.close(); }
});

test('tenant-scope deletion is owner-only and refuses to drop teammates without force', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'owner@deletion.test', password: 'correct horse battery staple', tenantName: 'Org' });
    addMember(fx.db, owner.tenant_id, { email: 'member@deletion.test' });

    // A member cannot wipe the tenant.
    const memberToken = await login(fx, 'member@deletion.test');
    const forbidden = await fx.request('/me', { method: 'DELETE', token: memberToken, body: { confirmEmail: 'member@deletion.test', scope: 'tenant' } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error, 'FORBIDDEN');

    // The owner is blocked while other members exist.
    const ownerToken = await login(fx, 'owner@deletion.test');
    const guarded = await fx.request('/me', { method: 'DELETE', token: ownerToken, body: { confirmEmail: 'owner@deletion.test', scope: 'tenant' } });
    assert.equal(guarded.status, 409);
    assert.equal(guarded.body.error, 'ORG_TENANT_HAS_OTHER_MEMBERS');
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', owner.tenant_id).n, 1);

    // `force` overrides the guard.
    const forced = await fx.request('/me', { method: 'DELETE', token: ownerToken, body: { confirmEmail: 'owner@deletion.test', scope: 'tenant', force: true } });
    assert.equal(forced.status, 200);
    assert.equal(forced.body.scope, 'tenant');
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', owner.tenant_id).n, 0);
  } finally { await fx.close(); }
});

test('a wrong confirmation email is rejected and deletes nothing', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'owner@deletion.test', password: 'correct horse battery staple', tenantName: 'Org' });
    const token = await login(fx, 'owner@deletion.test');
    const bad = await fx.request('/me', { method: 'DELETE', token, body: { confirmEmail: 'someone-else@deletion.test' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'DELETE_CONFIRMATION_REQUIRED');
    assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM tenants WHERE id=?', owner.tenant_id).n, 1);
  } finally { await fx.close(); }
});

test('GET /me/export returns a complete, self-scoped data export', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'owner@deletion.test', password: 'correct horse battery staple', tenantName: 'Org' });
    const member = addMember(fx.db, owner.tenant_id, { email: 'member@deletion.test' });

    // Seed a project/task/run owned by the member, a conversation + chat message,
    // an audit entry, and an outbox email addressed to the member.
    const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task'); const runId = id('run');
    fx.db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, owner.tenant_id, member.id, 'p', now());
    fx.db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, '/tmp', now());
    fx.db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, owner.tenant_id, projectId, workspaceId, member.id, 'goal', 'completed', now(), now());
    fx.db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, owner.tenant_id, 'completed', JSON.stringify({ kind: 'agent.run' }), 1, now(), now());
    const convId = id('conv');
    fx.db.run('INSERT INTO conversations(id,tenant_id,user_id,title,mode,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', convId, owner.tenant_id, member.id, 'thread', 'chat', 'active', now(), now());
    fx.db.run('INSERT INTO chat_messages(id,conversation_id,tenant_id,user_id,role,content,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id('msg'), convId, owner.tenant_id, member.id, 'user', 'hello', 'complete', now(), now());
    fx.db.run('INSERT INTO audit_logs(id,tenant_id,user_id,action,metadata_json,created_at) VALUES(?,?,?,?,?,?)', id('audit'), owner.tenant_id, member.id, 'chat.stream.completed', '{}', now());
    fx.db.run('INSERT INTO email_outbox(id,tenant_id,to_email,template,subject,body,status,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('email'), owner.tenant_id, 'member@deletion.test', 'invitation', 's', 'b', 'sent', 1, now(), now());

    const token = await login(fx, 'member@deletion.test');
    const exported = await fx.request('/me/export', { token });
    assert.equal(exported.status, 200);
    const body = exported.body;
    assert.equal(body.user.email, 'member@deletion.test');
    assert.ok(Array.isArray(body.memberships) && body.memberships.length === 1);
    assert.equal(body.projects.length, 1);
    assert.equal(body.conversations.length, 1);
    assert.equal(body.chatMessages.length, 1);
    assert.equal(body.runs.length, 1);
    assert.ok(body.usage && typeof body.usage === 'object');
    assert.ok(body.audit.some((row) => row.action === 'chat.stream.completed'));
    assert.ok(body.outbox.some((row) => row.to_email === 'member@deletion.test'));
    assert.ok(body.exportedAt);

    // The export is self-scoped: the owner sees none of the member's rows.
    const ownerToken = await login(fx, 'owner@deletion.test');
    const ownerExport = await fx.request('/me/export', { token: ownerToken });
    assert.equal(ownerExport.body.conversations.length, 0);
    assert.equal(ownerExport.body.runs.length, 0);
    assert.equal(ownerExport.body.outbox.length, 0);
  } finally { await fx.close(); }
});
