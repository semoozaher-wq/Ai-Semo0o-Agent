/**
 * Owner-approved access — requests, decisions, and optional device trust.
 *
 * The platform is a PRIVATE application: open sign-up is closed in production.
 * This module adds an EXPLICITLY OPT-IN workflow so a prospective user can ask
 * for access and an existing OWNER can decide — without ever reopening public
 * registration and without any path that self-grants access.
 *
 * Invariants (enforced here, never bypassable by the API layer):
 *   - A public request NEVER creates an account and NEVER issues a session. It
 *     only records intent (`access_requests`, status 'pending').
 *   - Only an authenticated OWNER may approve or reject (enforced at the route
 *     layer with `requireRole(user, ['owner'])`). Admins cannot decide.
 *   - Approval mints a ONE-TIME setup token (stored hashed). Completion consumes
 *     it exactly once and creates a `member` account — the role is HARDCODED, so
 *     an approved requester can never become owner or admin (no escalation).
 *   - Approval refuses an email that already has an account in the tenant, so a
 *     request can never overwrite or duplicate an existing user.
 *   - The requester has no account, so they can never approve their own request
 *     (no self-approval). The API is Bearer-token based (no cookies), so the
 *     approval routes are not reachable by a cross-site form (no CSRF).
 *
 * Device trust is a separate, OPT-IN control (REQUIRE_DEVICE_APPROVAL). It is
 * OFF by default, so ordinary logins are never gated; when enabled it only asks
 * the owner to approve a device the account has not been seen on before.
 */
import { createHash, randomBytes } from 'node:crypto';
import { id, now } from '../db/client.mjs';
import { createSession, passwordHash } from './security.mjs';

const SETUP_TOKEN_DAYS = 3;
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const isTrue = (value) => TRUE_VALUES.has(String(value ?? '').trim().toLowerCase());
const emailOf = (value) => String(value ?? '').trim().toLowerCase();
const isEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
const tokenHash = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

function audit(db, tenantId, action, resourceId, metadata, actorId) {
  db.run(
    'INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
    id('audit'), tenantId ?? null, action, 'access', resourceId, JSON.stringify({ ...metadata, actorId: actorId ?? null }), now(),
  );
}

/** Access requests are opt-in; the default posture keeps the endpoint closed. */
export function accessRequestsEnabled(env = process.env) {
  return isTrue(env.ALLOW_ACCESS_REQUESTS);
}

/** Device approval is opt-in and OFF by default so ordinary logins are unaffected. */
export function deviceApprovalRequired(env = process.env) {
  return isTrue(env.REQUIRE_DEVICE_APPROVAL);
}

// --- Access requests --------------------------------------------------------

/**
 * Record a public access request. Never creates an account or a session.
 * Throws `ACCESS_REQUESTS_DISABLED` when the workflow is not enabled.
 */
export function requestAccess(db, input = {}, env = process.env) {
  if (!accessRequestsEnabled(env)) throw new Error('ACCESS_REQUESTS_DISABLED');
  const email = emailOf(input.email);
  if (!isEmail(email)) throw new Error('INVALID_REQUEST_EMAIL');
  const name = input.name ? String(input.name).trim().slice(0, 120) : null;
  const reason = input.reason ? String(input.reason).trim().slice(0, 500) : null;

  // De-duplicate: an open (pending/approved) request for the same email is
  // returned as-is so a retry cannot flood the owner's queue.
  const existing = db.get(
    "SELECT id, status FROM access_requests WHERE lower(email)=lower(?) AND status IN ('pending','approved') ORDER BY requested_at DESC LIMIT 1",
    email,
  );
  if (existing) return { requestId: existing.id, status: existing.status, deduped: true };

  const requestId = id('access');
  db.run(
    'INSERT INTO access_requests(id,email,name,reason,status,requested_at) VALUES(?,?,?,?,?,?)',
    requestId, email, name, reason, 'pending', now(),
  );
  audit(db, null, 'access.requested', requestId, { email }, null);
  return { requestId, status: 'pending', deduped: false };
}

/** Owner view: pending requests plus this tenant's decided requests. */
export function listAccessRequests(db, tenantId, { status } = {}) {
  const rows = status
    ? db.all('SELECT * FROM access_requests WHERE (tenant_id IS NULL OR tenant_id=?) AND status=? ORDER BY requested_at DESC LIMIT 200', tenantId, status)
    : db.all('SELECT * FROM access_requests WHERE (tenant_id IS NULL OR tenant_id=?) ORDER BY requested_at DESC LIMIT 200', tenantId);
  return rows.map((row) => ({
    requestId: row.id,
    email: row.email,
    name: row.name,
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    completedUserId: row.completed_user_id,
  }));
}

/**
 * Owner decision: approve. Mints a one-time setup token (returned ONCE) that the
 * owner hands to the requester out-of-band. Never creates the account itself.
 */
export function approveAccessRequest(db, { tenantId, requestId, actorId }) {
  const request = db.get('SELECT * FROM access_requests WHERE id=?', requestId);
  if (!request || (request.tenant_id && request.tenant_id !== tenantId)) throw new Error('ACCESS_REQUEST_NOT_FOUND');
  if (request.status !== 'pending') throw new Error('ACCESS_REQUEST_NOT_PENDING');
  // Never approve over an existing account (no overwrite, no duplicate).
  if (db.get('SELECT id FROM users WHERE tenant_id=? AND lower(email)=lower(?)', tenantId, request.email)) {
    throw new Error('ACCESS_REQUEST_EMAIL_REGISTERED');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_DAYS * 86400000).toISOString();
  const timestamp = now();
  db.transaction(() => {
    db.run(
      'UPDATE access_requests SET status=?, tenant_id=?, setup_token_hash=?, setup_expires_at=?, decided_at=?, decided_by=? WHERE id=? AND status=?',
      'approved', tenantId, tokenHash(token), expiresAt, timestamp, actorId, requestId, 'pending',
    );
    audit(db, tenantId, 'access.approved', requestId, { email: request.email }, actorId);
  });
  return { requestId, status: 'approved', email: request.email, setupToken: token, expiresAt };
}

/** Owner decision: reject. No token is minted. */
export function rejectAccessRequest(db, { tenantId, requestId, actorId }) {
  const request = db.get('SELECT * FROM access_requests WHERE id=?', requestId);
  if (!request || (request.tenant_id && request.tenant_id !== tenantId)) throw new Error('ACCESS_REQUEST_NOT_FOUND');
  if (request.status !== 'pending') throw new Error('ACCESS_REQUEST_NOT_PENDING');
  db.run(
    'UPDATE access_requests SET status=?, decided_at=?, decided_by=? WHERE id=? AND status=?',
    'rejected', now(), actorId, requestId, 'pending',
  );
  audit(db, tenantId, 'access.rejected', requestId, { email: request.email }, actorId);
  return { requestId, status: 'rejected' };
}

/**
 * Requester completion: consume the one-time setup token and create the account.
 * The role is HARDCODED to `member` — approval can never grant owner/admin.
 */
export function completeAccessRequest(db, { setupToken, password }) {
  const row = db.get(
    "SELECT * FROM access_requests WHERE setup_token_hash=? AND status='approved' AND used_at IS NULL",
    tokenHash(setupToken),
  );
  if (!row || !row.setup_expires_at || Date.parse(row.setup_expires_at) <= Date.now() || !row.tenant_id) {
    throw new Error('ACCESS_REQUEST_TOKEN_INVALID');
  }
  if (typeof password !== 'string' || password.length < 12) throw new Error('PASSWORD_POLICY_FAILED');

  const hashed = passwordHash(password);
  const timestamp = now();
  const userId = id('user');
  return db.transaction(() => {
    db.run(
      'INSERT INTO users(id,tenant_id,email,password_hash,role,email_verified_at,created_at) VALUES(?,?,?,?,?,?,?)',
      userId, row.tenant_id, row.email, hashed, 'member', timestamp, timestamp,
    );
    db.run(
      'INSERT OR REPLACE INTO tenant_members(tenant_id,user_id,role,status,created_at) VALUES(?,?,?,?,?)',
      row.tenant_id, userId, 'member', 'active', timestamp,
    );
    db.run(
      'UPDATE access_requests SET status=?, used_at=?, completed_user_id=? WHERE id=? AND used_at IS NULL',
      'completed', timestamp, userId, row.id,
    );
    audit(db, row.tenant_id, 'access.completed', row.id, { email: row.email, userId }, userId);
    const session = createSession(db, userId);
    return { user: { id: userId, tenantId: row.tenant_id, email: row.email, role: 'member' }, session };
  });
}

// --- Device trust (opt-in) --------------------------------------------------

/**
 * Resolve whether a login from `deviceId` may proceed. Returns
 * `{trusted: true}` for a known device, otherwise `{trusted: false, requestId}`
 * after recording a pending device request. Only called when device approval is
 * enabled.
 */
export function checkDevice(db, { userId, deviceId, label }) {
  if (!deviceId) return { trusted: false, requestId: null, reason: 'DEVICE_ID_REQUIRED' };
  const normalized = String(deviceId).trim().slice(0, 200);
  const row = db.get('SELECT id, status FROM device_trust WHERE user_id=? AND device_id=?', userId, normalized);
  if (row?.status === 'trusted') {
    db.run('UPDATE device_trust SET last_seen_at=? WHERE id=?', now(), row.id);
    return { trusted: true };
  }
  if (row) return { trusted: false, requestId: row.id, reason: row.status === 'rejected' ? 'DEVICE_REJECTED' : 'DEVICE_PENDING' };

  const user = db.get('SELECT tenant_id FROM users WHERE id=?', userId);
  const requestId = id('device');
  db.run(
    'INSERT INTO device_trust(id,tenant_id,user_id,device_id,label,status,requested_at) VALUES(?,?,?,?,?,?,?)',
    requestId, user.tenant_id, userId, normalized, label ? String(label).trim().slice(0, 120) : null, 'pending', now(),
  );
  audit(db, user.tenant_id, 'device.requested', requestId, { deviceId: normalized }, userId);
  return { trusted: false, requestId, reason: 'DEVICE_PENDING' };
}

export function listDevices(db, tenantId, { status } = {}) {
  const rows = status
    ? db.all('SELECT * FROM device_trust WHERE tenant_id=? AND status=? ORDER BY requested_at DESC LIMIT 200', tenantId, status)
    : db.all('SELECT * FROM device_trust WHERE tenant_id=? ORDER BY requested_at DESC LIMIT 200', tenantId);
  return rows.map((row) => ({
    deviceRequestId: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    label: row.label,
    status: row.status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export function approveDevice(db, { tenantId, deviceRequestId, actorId }) {
  const row = db.get('SELECT * FROM device_trust WHERE id=? AND tenant_id=?', deviceRequestId, tenantId);
  if (!row) throw new Error('DEVICE_REQUEST_NOT_FOUND');
  if (row.status === 'trusted') return { deviceRequestId, status: 'trusted' };
  db.run('UPDATE device_trust SET status=?, decided_at=?, decided_by=? WHERE id=?', 'trusted', now(), actorId, deviceRequestId);
  audit(db, tenantId, 'device.approved', deviceRequestId, { deviceId: row.device_id }, actorId);
  return { deviceRequestId, status: 'trusted' };
}

export function rejectDevice(db, { tenantId, deviceRequestId, actorId }) {
  const row = db.get('SELECT * FROM device_trust WHERE id=? AND tenant_id=?', deviceRequestId, tenantId);
  if (!row) throw new Error('DEVICE_REQUEST_NOT_FOUND');
  db.run('UPDATE device_trust SET status=?, decided_at=?, decided_by=? WHERE id=?', 'rejected', now(), actorId, deviceRequestId);
  audit(db, tenantId, 'device.rejected', deviceRequestId, { deviceId: row.device_id }, actorId);
  return { deviceRequestId, status: 'rejected' };
}
