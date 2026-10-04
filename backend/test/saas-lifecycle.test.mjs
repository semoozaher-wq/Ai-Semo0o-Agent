import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { authenticate, createUser, passwordHash } from '../auth/security.mjs';
import { acceptInvitation, consumeQuota, createInvitation, enableMfa, issueAccountToken, resetPassword, verifyEmail } from '../auth/lifecycle.mjs';

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

test('MFA-enabled accounts require a second factor before session creation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-mfa-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const user = createUser(db, { email: 'mfa@saas.test', password: 'correct horse battery staple', tenantName: 'MFA' });
    db.run('UPDATE users SET mfa_enabled=1 WHERE id=?', user.id);
    assert.throws(() => authenticate(db, user.email, 'correct horse battery staple'), /MFA_REQUIRED/);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?', user.id).count, 0);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('MFA recovery codes are hashed and single-use', async () => {
  const previousKey = process.env.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEY = '11'.repeat(32);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-recovery-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const user = createUser(db, { email: 'recovery@saas.test', password: 'correct horse battery staple', tenantName: 'Recovery' });
    const setup = enableMfa(db, user.id);
    assert.equal(setup.recoveryCodes.length, 10);
    assert.equal(db.get('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id=? AND used_at IS NULL', user.id).count, 10);
    db.run('UPDATE users SET mfa_enabled=1 WHERE id=?', user.id);
    const session = authenticate(db, user.email, 'correct horse battery staple', setup.recoveryCodes[0]);
    assert.ok(session.session.token);
    assert.throws(() => authenticate(db, user.email, 'correct horse battery staple', setup.recoveryCodes[0]), /MFA_CODE_INVALID/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); if (previousKey === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = previousKey; }
});

test('quota consumption is atomic and leaves counters unchanged when rejected', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-quota-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const owner = createUser(db, { email: 'quota@saas.test', password: 'correct horse battery staple', tenantName: 'Quota' });
    db.run('UPDATE usage_quotas SET monthly_tokens=100, monthly_runs=1 WHERE tenant_id=?', owner.tenant_id);
    consumeQuota(db, owner.tenant_id, { tokens: 60, runs: 1 });
    assert.equal(db.get('SELECT tokens,runs FROM usage_counters WHERE tenant_id=?', owner.tenant_id).tokens, 60);
    // Token overrun must be rejected and must NOT partially write the counter.
    assert.throws(() => consumeQuota(db, owner.tenant_id, { tokens: 60 }), /MONTHLY_TOKEN_QUOTA_EXCEEDED/);
    assert.equal(db.get('SELECT tokens FROM usage_counters WHERE tenant_id=?', owner.tenant_id).tokens, 60);
    // Negative deltas are rejected outright.
    assert.throws(() => consumeQuota(db, owner.tenant_id, { tokens: -10 }), /INVALID_QUOTA_DELTA/);
    // Run overrun is rejected and leaves the run counter untouched.
    assert.throws(() => consumeQuota(db, owner.tenant_id, { runs: 1 }), /MONTHLY_RUN_QUOTA_EXCEEDED/);
    assert.equal(db.get('SELECT runs FROM usage_counters WHERE tenant_id=?', owner.tenant_id).runs, 1);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
