import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createUser, passwordHash } from '../auth/security.mjs';
import { acceptInvitation, consumeQuota, createInvitation, issueAccountToken, resetPassword, verifyEmail } from '../auth/lifecycle.mjs';

test('SaaS lifecycle creates owner membership and quota, verifies email, and resets password', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-saas-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const user = createUser(db, { email: 'owner@saas.test', password: 'correct horse battery staple', tenantName: 'SaaS' });
    assert.equal(db.get('SELECT role FROM tenant_members WHERE tenant_id=? AND user_id=?', user.tenant_id, user.id).role, 'owner');
    assert.equal(db.get('SELECT monthly_runs FROM usage_quotas WHERE tenant_id=?', user.tenant_id).monthly_runs, 1000);
    const emailToken = issueAccountToken(db, user.id, 'email_verification');
    assert.equal(verifyEmail(db, emailToken).email_verified_at !== null, true);
    const resetToken = issueAccountToken(db, user.id, 'password_reset');
    resetPassword(db, resetToken, 'new correct horse battery staple', passwordHash);
    assert.equal(db.get('SELECT password_hash FROM users WHERE id=?', user.id).password_hash.includes('scrypt$'), true);
    assert.throws(() => verifyEmail(db, emailToken), /ACCOUNT_TOKEN_INVALID_OR_EXPIRED/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('SaaS invitations are role-scoped, email-bound, one-time, and quota enforced', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-saas-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const owner = createUser(db, { email: 'owner@invite.test', password: 'correct horse battery staple', tenantName: 'Invite' });
    const member = createUser(db, { email: 'member@invite.test', password: 'correct horse battery staple', tenantName: 'Other' });
    const invite = createInvitation(db, { tenantId: owner.tenant_id, invitedBy: owner.id, email: member.email, role: 'member' });
    const membership = acceptInvitation(db, { token: invite.token, userId: member.id });
    assert.deepEqual({ tenant_id: membership.tenant_id, user_id: membership.user_id, role: membership.role }, { tenant_id: owner.tenant_id, user_id: member.id, role: 'member' });
    assert.throws(() => acceptInvitation(db, { token: invite.token, userId: member.id }), /INVITATION_INVALID_OR_EXPIRED/);
    consumeQuota(db, owner.tenant_id, { runs: 1, tokens: 12 });
    assert.equal(db.get('SELECT runs,tokens FROM usage_counters WHERE tenant_id=?', owner.tenant_id).runs, 1);
    db.run('UPDATE usage_quotas SET monthly_runs=1 WHERE tenant_id=?', owner.tenant_id);
    assert.throws(() => consumeQuota(db, owner.tenant_id, { runs: 1 }), /MONTHLY_RUN_QUOTA_EXCEEDED/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
