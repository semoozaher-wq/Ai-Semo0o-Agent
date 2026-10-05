import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';
import { listInvitations, listMembers, removeMember, revokeInvitation, updateMemberRole } from '../org/members.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-org-'));
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

// Put a freshly-created user into an existing tenant as a member of `role`.
function addMember(db, tenantId, email, role) {
  const user = createUser(db, { email, password: 'correct horse battery staple', tenantName: email });
  db.run('UPDATE users SET tenant_id=?, role=? WHERE id=?', tenantId, role, user.id);
  db.run('INSERT OR REPLACE INTO tenant_members(tenant_id,user_id,role,status,created_at) VALUES(?,?,?,?,?)', tenantId, user.id, role, 'active', now());
  return user;
}

test('listMembers returns the roster and role updates sync the auth identity', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'owner@org.test', password: 'correct horse battery staple', tenantName: 'Org' });
    const member = addMember(fx.db, owner.tenant_id, 'member@org.test', 'member');

    const roster = listMembers(fx.db, owner.tenant_id);
    assert.equal(roster.length, 2);
    assert.ok(roster.some((row) => row.userId === owner.id && row.role === 'owner'));
    assert.ok(roster.some((row) => row.userId === member.id && row.role === 'member'));

    const updated = updateMemberRole(fx.db, { tenantId: owner.tenant_id, userId: member.id, role: 'admin', actorId: owner.id });
    assert.equal(updated.role, 'admin');
    // The home identity must reflect the new role so authenticateToken enforces it.
    assert.equal(fx.db.get('SELECT role FROM users WHERE id=?', member.id).role, 'admin');
    const audit = fx.db.get("SELECT * FROM audit_logs WHERE action='org.member.role_changed' AND resource_id=?", member.id);
    assert.ok(audit, 'role change must be audited');
  } finally { await fx.close(); }
});

test('the last owner can never be demoted, removed, or silently transferred', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'solo@org.test', password: 'correct horse battery staple', tenantName: 'Solo' });
    assert.throws(() => updateMemberRole(fx.db, { tenantId: owner.tenant_id, userId: owner.id, role: 'admin', actorId: owner.id }), /ORG_LAST_OWNER_PROTECTED/);
    assert.throws(() => removeMember(fx.db, { tenantId: owner.tenant_id, userId: owner.id, actorId: owner.id }), /ORG_LAST_OWNER_PROTECTED/);
    assert.throws(() => updateMemberRole(fx.db, { tenantId: owner.tenant_id, userId: owner.id, role: 'owner', actorId: owner.id }), /ORG_OWNER_TRANSFER_REQUIRES_DEDICATED_FLOW/);
    assert.throws(() => updateMemberRole(fx.db, { tenantId: owner.tenant_id, userId: owner.id, role: 'superuser', actorId: owner.id }), /ORG_ROLE_INVALID/);
    // Still exactly one owner after the rejected attempts.
    assert.equal(fx.db.get("SELECT COUNT(*) AS n FROM tenant_members WHERE tenant_id=? AND role='owner'", owner.tenant_id).n, 1);
  } finally { await fx.close(); }
});

test('invitations can be listed and revoked, and a revoked invite cannot be accepted', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'inv-owner@org.test', password: 'correct horse battery staple', tenantName: 'InvOrg' });
    const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'inv-owner@org.test', password: 'correct horse battery staple' } });
    const token = login.body.session.token;

    const created = await fx.request('/org/invitations', { method: 'POST', token, body: { email: 'newbie@org.test', role: 'member' } });
    assert.equal(created.status, 201);
    const invitationId = created.body.invitationId;

    const listed = await fx.request('/org/invitations', { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.invitations.length, 1);
    assert.equal(listed.body.invitations[0].invitationId, invitationId);

    const revoked = await fx.request(`/org/invitations/${invitationId}`, { method: 'DELETE', token });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);
    assert.equal(listInvitations(fx.db, owner.tenant_id).length, 0);
    assert.throws(() => revokeInvitation(fx.db, { tenantId: owner.tenant_id, invitationId, actorId: owner.id }), /ORG_INVITATION_NOT_FOUND/);
  } finally { await fx.close(); }
});

test('org API enforces RBAC, tenant isolation, and session revocation on removal', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'rbac-owner@org.test', password: 'correct horse battery staple', tenantName: 'RbacOrg' });
    const member = addMember(fx.db, owner.tenant_id, 'rbac-member@org.test', 'member');
    const outsider = createUser(fx.db, { email: 'rbac-outsider@org.test', password: 'correct horse battery staple', tenantName: 'Outsider' });

    const ownerLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'rbac-owner@org.test', password: 'correct horse battery staple' } });
    const ownerToken = ownerLogin.body.session.token;
    const memberLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'rbac-member@org.test', password: 'correct horse battery staple' } });
    const memberToken = memberLogin.body.session.token;
    const outsiderLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'rbac-outsider@org.test', password: 'correct horse battery staple' } });
    const outsiderToken = outsiderLogin.body.session.token;

    // A member cannot read the roster or mutate it.
    assert.equal((await fx.request('/org/members', { token: memberToken })).status, 403);
    assert.equal((await fx.request(`/org/members/${member.id}`, { method: 'PATCH', token: memberToken, body: { role: 'admin' } })).status, 403);

    // Owner can read the roster.
    const roster = await fx.request('/org/members', { token: ownerToken });
    assert.equal(roster.status, 200);
    assert.equal(roster.body.members.length, 2);

    // An outsider (owner of a different tenant) sees only their own empty roster
    // and cannot touch another tenant's members (which resolve to 404, not leaked).
    const outsiderRoster = await fx.request('/org/members', { token: outsiderToken });
    assert.equal(outsiderRoster.status, 200);
    assert.equal(outsiderRoster.body.members.length, 1);
    assert.equal(outsiderRoster.body.members[0].userId, outsider.id);
    assert.equal(outsiderRoster.body.members.some((row) => row.userId === owner.id), false);
    const crossTenant = await fx.request(`/org/members/${owner.id}`, { method: 'DELETE', token: outsiderToken });
    assert.equal(crossTenant.status, 404);
    // The owner's roster is untouched by the cross-tenant attempt.
    assert.equal(listMembers(fx.db, owner.tenant_id).length, 2);

    // Owner promotes then removes the member; the member's session is revoked.
    const promoted = await fx.request(`/org/members/${member.id}`, { method: 'PATCH', token: ownerToken, body: { role: 'admin' } });
    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.member.role, 'admin');

    const removed = await fx.request(`/org/members/${member.id}`, { method: 'DELETE', token: ownerToken });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
    // The removed member's token no longer authenticates.
    assert.equal((await fx.request('/org/members', { token: memberToken })).status, 401);

    // A non-existent member is a clean 404.
    assert.equal((await fx.request('/org/members/user_missing', { method: 'DELETE', token: ownerToken })).status, 404);
  } finally { await fx.close(); }
});
