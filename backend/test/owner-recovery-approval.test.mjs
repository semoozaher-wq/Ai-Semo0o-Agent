/**
 * Secure owner recovery + owner-approved access.
 *
 * Two features are covered end to end:
 *
 *   1. Owner recovery (`backend/auth/recovery.mjs`) — a Shell-free way to reset
 *      the OWNER password from protected env vars. It is opt-in, strictly
 *      existing-account-only, owner-only, one-time, and revokes sessions.
 *
 *   2. Owner-approved access (`backend/auth/approvals.mjs`) — an opt-in workflow
 *      where a public request never creates an account, only an authenticated
 *      OWNER may decide, and completion always yields a `member` (never owner).
 *
 * The tests are ISOLATED and LOCAL: every one runs against a throwaway SQLite
 * file in the OS temp directory and a loopback HTTP server. None touch any
 * production database or the live Render deployment.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { authenticate, authenticateToken, createSession, createUser } from '../auth/security.mjs';
import { recoverOwner } from '../auth/recovery.mjs';
import { approveAccessRequest, completeAccessRequest, listAccessRequests, rejectAccessRequest, requestAccess } from '../auth/approvals.mjs';

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a-brand-new-passphrase-123';

function withDb(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'semo0o-owner-db-'));
  try {
    return fn(new Database(path.join(dir, 'agent.sqlite')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-owner-http-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, codeRunner: async () => ({ status: 'completed' }) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      method: options.method,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return {
    dir, db, queue, app, base, request,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Correct / incorrect login
// ---------------------------------------------------------------------------

test('login succeeds with the right password and fails with the wrong one', async () => {
  const fx = await fixture();
  try {
    createUser(fx.db, { email: 'login@owner.test', password: PASSWORD, tenantName: 'Login' });
    const ok = await fx.request('/auth/login', { method: 'POST', body: { email: 'login@owner.test', password: PASSWORD } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.session?.token, 'a session is issued');
    assert.equal(ok.body.user.role, 'owner');

    const bad = await fx.request('/auth/login', { method: 'POST', body: { email: 'login@owner.test', password: 'wrong-password-000' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'INVALID_CREDENTIALS');
  } finally { await fx.close(); }
});

// ---------------------------------------------------------------------------
// 2. Recovery authorization + rejection of unauthorized requests
// ---------------------------------------------------------------------------

test('recovery is a no-op when unconfigured and never creates a missing account', () => {
  withDb((db) => {
    assert.equal(recoverOwner(db, {}).reason, 'NOT_CONFIGURED');
    const missing = recoverOwner(db, { RECOVERY_ADMIN_EMAIL: 'ghost@owner.test', RECOVERY_ADMIN_PASSWORD: NEW_PASSWORD });
    assert.equal(missing.applied, false);
    assert.equal(missing.reason, 'ACCOUNT_NOT_FOUND');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 0, 'recovery never provisions an account');
    db.close();
  });
});

test('recovery refuses to escalate a non-owner account', () => {
  withDb((db) => {
    const member = createUser(db, { email: 'member@owner.test', password: PASSWORD, tenantName: 'M' });
    db.run("UPDATE users SET role='member' WHERE id=?", member.id);
    const result = recoverOwner(db, { RECOVERY_ADMIN_EMAIL: 'member@owner.test', RECOVERY_ADMIN_PASSWORD: NEW_PASSWORD });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'NOT_OWNER');
    // The password is untouched — the old one still works.
    assert.ok(authenticate(db, 'member@owner.test', PASSWORD).session.token);
    db.close();
  });
});

test('recovery fails closed on a half-configured or policy-violating request', () => {
  withDb((db) => {
    assert.throws(() => recoverOwner(db, { RECOVERY_ADMIN_EMAIL: 'x@owner.test' }), /RECOVERY_ADMIN_PASSWORD_MISSING/);
    assert.throws(() => recoverOwner(db, { RECOVERY_ADMIN_PASSWORD: NEW_PASSWORD }), /RECOVERY_ADMIN_EMAIL_MISSING/);
    assert.throws(() => recoverOwner(db, { RECOVERY_ADMIN_EMAIL: 'not-an-email', RECOVERY_ADMIN_PASSWORD: NEW_PASSWORD }), /RECOVERY_ADMIN_EMAIL_INVALID/);
    assert.throws(() => recoverOwner(db, { RECOVERY_ADMIN_EMAIL: 'x@owner.test', RECOVERY_ADMIN_PASSWORD: 'short' }), /PASSWORD_POLICY_FAILED/);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 0, 'nothing written on failure');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 3. Existing-account handling + duplicate prevention
// ---------------------------------------------------------------------------

test('recovery resets an existing owner and never creates a duplicate', () => {
  withDb((db) => {
    const owner = createUser(db, { email: 'boss@owner.test', password: PASSWORD, tenantName: 'Boss' });
    const result = recoverOwner(db, { RECOVERY_ADMIN_EMAIL: 'boss@owner.test', RECOVERY_ADMIN_PASSWORD: NEW_PASSWORD });
    assert.equal(result.applied, true);
    assert.equal(result.userId, owner.id, 'the SAME account is updated, not replaced');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM users').n, 1, 'no duplicate account');
    assert.ok(authenticate(db, 'boss@owner.test', NEW_PASSWORD).session.token, 'new password works');
    assert.throws(() => authenticate(db, 'boss@owner.test', PASSWORD), /INVALID_CREDENTIALS/);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Owner approve / reject workflows
// ---------------------------------------------------------------------------

test('owner approves a request and the requester completes as a member', async () => {
  const fx = await fixture();
  try {
    createUser(fx.db, { email: 'approver@owner.test', password: PASSWORD, tenantName: 'Approve' });
    await withEnv({ ALLOW_ACCESS_REQUESTS: 'true' }, async () => {
      const submitted = await fx.request('/access/request', { method: 'POST', body: { email: 'newbie@owner.test', name: 'Newbie', reason: 'I need access' } });
      assert.equal(submitted.status, 202);
      assert.equal(submitted.body.accepted, true);
      assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM users WHERE lower(email)=?', 'newbie@owner.test').n, 0, 'a request never creates an account');

      const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'approver@owner.test', password: PASSWORD } });
      const token = login.body.session.token;

      const listed = await fx.request('/access/requests', { token });
      assert.equal(listed.status, 200);
      assert.equal(listed.body.requests.length, 1);
      assert.equal(listed.body.requests[0].status, 'pending');
      const requestId = listed.body.requests[0].requestId;

      const approved = await fx.request(`/access/requests/${requestId}/approve`, { method: 'POST', token });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.status, 'approved');
      assert.ok(approved.body.setupToken, 'a one-time setup token is returned');

      const completed = await fx.request('/access/complete', { method: 'POST', body: { setupToken: approved.body.setupToken, password: PASSWORD } });
      assert.equal(completed.status, 201, JSON.stringify(completed.body));
      assert.equal(completed.body.user.role, 'member', 'approved users are members, never owners');
      assert.ok(completed.body.session?.token);

      const memberLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'newbie@owner.test', password: PASSWORD } });
      assert.equal(memberLogin.status, 200);
      assert.equal(memberLogin.body.user.role, 'member');
    });
  } finally { await fx.close(); }
});

test('owner rejects a request and no account or token is produced', async () => {
  const fx = await fixture();
  try {
    createUser(fx.db, { email: 'rejecter@owner.test', password: PASSWORD, tenantName: 'Reject' });
    await withEnv({ ALLOW_ACCESS_REQUESTS: 'true' }, async () => {
      await fx.request('/access/request', { method: 'POST', body: { email: 'denied@owner.test' } });
      const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'rejecter@owner.test', password: PASSWORD } });
      const token = login.body.session.token;
      const listed = await fx.request('/access/requests', { token });
      const requestId = listed.body.requests[0].requestId;

      const rejected = await fx.request(`/access/requests/${requestId}/reject`, { method: 'POST', token });
      assert.equal(rejected.status, 200);
      assert.equal(rejected.body.status, 'rejected');
      assert.equal(rejected.body.setupToken, undefined, 'rejection mints no token');
      assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM users WHERE lower(email)=?', 'denied@owner.test').n, 0);
    });
  } finally { await fx.close(); }
});

// ---------------------------------------------------------------------------
// 5. Self-approval + unauthorized escalation prevention
// ---------------------------------------------------------------------------

test('only an owner can decide, and approval can never escalate a role', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'root@owner.test', password: PASSWORD, tenantName: 'Root' });
    const member = createUser(fx.db, { email: 'plain@owner.test', password: PASSWORD, tenantName: 'Plain' });
    fx.db.run('UPDATE users SET tenant_id=?, role=? WHERE id=?', owner.tenant_id, 'member', member.id);
    fx.db.run('INSERT OR REPLACE INTO tenant_members(tenant_id,user_id,role,status,created_at) VALUES(?,?,?,?,?)', owner.tenant_id, member.id, 'member', 'active', now());

    await withEnv({ ALLOW_ACCESS_REQUESTS: 'true' }, async () => {
      await fx.request('/access/request', { method: 'POST', body: { email: 'candidate@owner.test' } });
      const requestId = fx.db.get('SELECT id FROM access_requests WHERE lower(email)=?', 'candidate@owner.test').id;

      // Unauthenticated callers cannot list or decide.
      assert.equal((await fx.request('/access/requests', {})).status, 401);
      assert.equal((await fx.request(`/access/requests/${requestId}/approve`, { method: 'POST', body: {} })).status, 401);

      // A member cannot list or decide (owner-only).
      const memberLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'plain@owner.test', password: PASSWORD } });
      const memberToken = memberLogin.body.session.token;
      assert.equal((await fx.request('/access/requests', { token: memberToken })).status, 403);
      assert.equal((await fx.request(`/access/requests/${requestId}/approve`, { method: 'POST', token: memberToken })).status, 403);
      assert.equal((await fx.request(`/access/requests/${requestId}/reject`, { method: 'POST', token: memberToken })).status, 403);

      // The owner approves; completion yields a member and the token is one-time.
      const ownerLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'root@owner.test', password: PASSWORD } });
      const ownerToken = ownerLogin.body.session.token;
      const approved = await fx.request(`/access/requests/${requestId}/approve`, { method: 'POST', token: ownerToken });
      assert.equal(approved.status, 200);
      const completed = await fx.request('/access/complete', { method: 'POST', body: { setupToken: approved.body.setupToken, password: PASSWORD } });
      assert.equal(completed.body.user.role, 'member');
      assert.notEqual(completed.body.user.role, 'owner');

      const replay = await fx.request('/access/complete', { method: 'POST', body: { setupToken: approved.body.setupToken, password: PASSWORD } });
      assert.equal(replay.status, 400);
      assert.equal(replay.body.error, 'ACCESS_REQUEST_TOKEN_INVALID', 'the setup token cannot be replayed');
    });
  } finally { await fx.close(); }
});

test('approval refuses a request whose email already has an account', async () => {
  const fx = await fixture();
  try {
    createUser(fx.db, { email: 'dupe-owner@owner.test', password: PASSWORD, tenantName: 'Dupe' });
    await withEnv({ ALLOW_ACCESS_REQUESTS: 'true' }, async () => {
      await fx.request('/access/request', { method: 'POST', body: { email: 'dupe-owner@owner.test' } });
      const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'dupe-owner@owner.test', password: PASSWORD } });
      const token = login.body.session.token;
      const requestId = fx.db.get('SELECT id FROM access_requests WHERE lower(email)=?', 'dupe-owner@owner.test').id;
      const approved = await fx.request(`/access/requests/${requestId}/approve`, { method: 'POST', token });
      assert.equal(approved.status, 409);
      assert.equal(approved.body.error, 'ACCESS_REQUEST_EMAIL_REGISTERED');
    });
  } finally { await fx.close(); }
});

// ---------------------------------------------------------------------------
// 6. Session revocation after a password reset
// ---------------------------------------------------------------------------

test('a recovery revokes every existing session for the account', () => {
  withDb((db) => {
    const owner = createUser(db, { email: 'sess@owner.test', password: PASSWORD, tenantName: 'S' });
    const live = createSession(db, owner.id);
    assert.ok(authenticateToken(db, live.token), 'session is live before recovery');

    const result = recoverOwner(db, { RECOVERY_ADMIN_EMAIL: 'sess@owner.test', RECOVERY_ADMIN_PASSWORD: NEW_PASSWORD });
    assert.equal(result.applied, true);
    assert.equal(result.sessionsRevoked, 1);
    assert.equal(authenticateToken(db, live.token), null, 'the old session no longer resolves');
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 7. One-time recovery + safe repeated execution
// ---------------------------------------------------------------------------

test('recovery is one-time and safe to re-run', () => {
  withDb((db) => {
    createUser(db, { email: 'once@owner.test', password: PASSWORD, tenantName: 'Once' });
    const env = { RECOVERY_ADMIN_EMAIL: 'once@owner.test', RECOVERY_ADMIN_PASSWORD: NEW_PASSWORD };

    assert.equal(recoverOwner(db, env).applied, true);
    const again = recoverOwner(db, env);
    assert.equal(again.applied, false);
    assert.equal(again.reason, 'ALREADY_APPLIED', 'a repeated boot is a no-op');

    // A new one-time token is a new, deliberate recovery.
    const withToken = recoverOwner(db, { ...env, RECOVERY_ADMIN_PASSWORD: 'another-fresh-passphrase-456', RECOVERY_TOKEN: 'token-abc' });
    assert.equal(withToken.applied, true);
    assert.ok(authenticate(db, 'once@owner.test', 'another-fresh-passphrase-456').session.token);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// 8. Public registration stays disabled
// ---------------------------------------------------------------------------

test('public registration stays disabled and access requests are opt-in', async () => {
  const fx = await fixture();
  try {
    await withEnv({ NODE_ENV: 'production', ALLOW_PUBLIC_REGISTRATION: undefined, APP_ACCESS_KEY: undefined, ALLOW_ACCESS_REQUESTS: undefined }, async () => {
      const register = await fx.request('/auth/register', { method: 'POST', body: { email: 'outsider@owner.test', password: PASSWORD } });
      assert.equal(register.status, 403);
      assert.equal(register.body.error, 'REGISTRATION_DISABLED');

      const request = await fx.request('/access/request', { method: 'POST', body: { email: 'wannabe@owner.test' } });
      assert.equal(request.status, 403);
      assert.equal(request.body.error, 'ACCESS_REQUESTS_DISABLED');
      assert.equal(fx.db.get('SELECT COUNT(*) AS n FROM users').n, 0, 'no account created');
    });
  } finally { await fx.close(); }
});

// ---------------------------------------------------------------------------
// 9. Regression: existing auth protections are unchanged
// ---------------------------------------------------------------------------

test('regression: the access-key gate and session validation still work', async () => {
  const fx = await fixture();
  try {
    await withEnv({ NODE_ENV: 'production', APP_ACCESS_KEY: 'the-real-key-123456', ALLOW_PUBLIC_REGISTRATION: undefined, ALLOW_ACCESS_REQUESTS: undefined }, async () => {
      const denied = await fx.request('/auth/register', { method: 'POST', body: { email: 'k@owner.test', password: PASSWORD } });
      assert.equal(denied.status, 403);
      assert.equal(denied.body.error, 'ACCESS_KEY_INVALID');

      const ok = await fx.request('/auth/register', { method: 'POST', body: { email: 'k@owner.test', password: PASSWORD, accessKey: 'the-real-key-123456' } });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      const token = ok.body.session.token;
      assert.equal((await fx.request('/auth/session', { token })).status, 200);
      await fx.request('/auth/logout', { method: 'POST', token });
      assert.equal((await fx.request('/auth/session', { token })).status, 401, 'a revoked token no longer resolves');
    });
  } finally { await fx.close(); }
});

// ---------------------------------------------------------------------------
// Device approval (opt-in): off by default, gates only new devices when enabled
// ---------------------------------------------------------------------------

test('device approval is opt-in and gates only new devices', async () => {
  const fx = await fixture();
  try {
    createUser(fx.db, { email: 'device@owner.test', password: PASSWORD, tenantName: 'Device' });

    // Default OFF: a login is never gated, even from an unknown device.
    const normal = await fx.request('/auth/login', { method: 'POST', body: { email: 'device@owner.test', password: PASSWORD, deviceId: 'dev-1' } });
    assert.equal(normal.status, 200);
    assert.ok(normal.body.session?.token);

    await withEnv({ REQUIRE_DEVICE_APPROVAL: 'true' }, async () => {
      const gated = await fx.request('/auth/login', { method: 'POST', body: { email: 'device@owner.test', password: PASSWORD, deviceId: 'dev-2' } });
      assert.equal(gated.status, 202);
      assert.equal(gated.body.deviceApprovalRequired, true);
      assert.ok(gated.body.deviceRequestId);
      assert.equal(gated.body.session, undefined, 'no session is issued before approval');

      const approved = await fx.request(`/devices/${gated.body.deviceRequestId}/approve`, { method: 'POST', token: normal.body.session.token });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.status, 'trusted');

      const after = await fx.request('/auth/login', { method: 'POST', body: { email: 'device@owner.test', password: PASSWORD, deviceId: 'dev-2' } });
      assert.equal(after.status, 200);
      assert.ok(after.body.session?.token, 'a trusted device logs in normally');
    });
  } finally { await fx.close(); }
});

// ---------------------------------------------------------------------------
// Direct module contracts (no HTTP)
// ---------------------------------------------------------------------------

test('requestAccess de-duplicates an open request for the same email', () => {
  withDb((db) => {
    const env = { ALLOW_ACCESS_REQUESTS: 'true' };
    const first = requestAccess(db, { email: 'dedupe@owner.test' }, env);
    const second = requestAccess(db, { email: 'DEDUPE@owner.test' }, env);
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(second.requestId, first.requestId);
    assert.equal(db.get('SELECT COUNT(*) AS n FROM access_requests').n, 1);
    db.close();
  });
});

test('approveAccessRequest only works on a pending request', () => {
  withDb((db) => {
    const env = { ALLOW_ACCESS_REQUESTS: 'true' };
    const owner = createUser(db, { email: 'decider@owner.test', password: PASSWORD, tenantName: 'Decider' });
    const { requestId } = requestAccess(db, { email: 'pending@owner.test' }, env);
    const approved = approveAccessRequest(db, { tenantId: owner.tenant_id, requestId, actorId: owner.id });
    assert.equal(approved.status, 'approved');
    assert.throws(() => approveAccessRequest(db, { tenantId: owner.tenant_id, requestId, actorId: owner.id }), /ACCESS_REQUEST_NOT_PENDING/);
    assert.throws(() => rejectAccessRequest(db, { tenantId: owner.tenant_id, requestId, actorId: owner.id }), /ACCESS_REQUEST_NOT_PENDING/);
    assert.equal(listAccessRequests(db, owner.tenant_id).length, 1);
    db.close();
  });
});

test('completeAccessRequest rejects an unknown or expired token', () => {
  withDb((db) => {
    assert.throws(() => completeAccessRequest(db, { setupToken: 'not-a-real-token', password: PASSWORD }), /ACCESS_REQUEST_TOKEN_INVALID/);
    db.close();
  });
});
