/**
 * Owner account recovery from environment variables — no Shell required.
 *
 * Why this exists
 * ---------------
 * A private deployment closes self-service sign-up, so the operator needs a
 * deliberate, out-of-band way to regain access to the OWNER account. There are
 * already two mechanisms for the *empty* database case:
 *
 *   - `scripts/create-admin.mjs`  — run a command on the host / Render Shell.
 *   - `bootstrapFirstOwner`       — set two env vars; creates the first owner
 *                                   ONLY when the users table is empty.
 *
 * Neither helps when the database already has accounts and the owner has lost
 * the password (or an old password is stuck in the host's secret store). Render
 * Free has no Shell, so this module covers that case the same way the bootstrap
 * does: two protected environment variables in the host dashboard.
 *
 * Safety rules (fail-closed, never destructive, never escalating):
 *   - Opt-in: does nothing unless RECOVERY_ADMIN_EMAIL and RECOVERY_ADMIN_PASSWORD
 *     are both set. The default posture is untouched.
 *   - EXISTING-ACCOUNT-ONLY: it never creates an account. If no account exists
 *     for the email it is a no-op (`ACCOUNT_NOT_FOUND`), so it can never be used
 *     to provision a new user, and it can never create a duplicate.
 *   - OWNER-ONLY: it refuses to touch an account whose role is not `owner`, so it
 *     can never be used to escalate a member/admin to owner.
 *   - ONE-TIME: every applied recovery records a fingerprint. Re-running the same
 *     request on a persistent database is a safe no-op (`ALREADY_APPLIED`); it
 *     never resets the password a second time.
 *   - REVOKES SESSIONS: a password reset revokes every existing session for the
 *     account, so a stolen token cannot survive the recovery.
 *   - Never logs and never returns the password.
 *
 * The password lives in the host's protected secret store, not in the database
 * in plaintext and not in any log line. Operators are encouraged to REMOVE the
 * two variables once recovery is complete, which also disables the mechanism.
 */
import { createHash } from 'node:crypto';
import { id, now } from '../db/client.mjs';
import { passwordHash } from './security.mjs';

const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * A stable, non-reversible fingerprint for a recovery request. It deliberately
 * hashes the email plus an OPTIONAL one-time token — never the password — so no
 * password-derived material is ever stored. When RECOVERY_TOKEN is omitted the
 * fingerprint is stable per email, which makes the recovery one-time per email
 * on a persistent database (documented in the operator guide).
 */
function fingerprintOf(email, token) {
  return createHash('sha256').update(`semo0o-owner-recovery:${email}:${token || 'no-token'}`).digest('hex');
}

/**
 * Apply an owner password recovery if (and only if) it is configured and safe.
 *
 * @returns {{applied: boolean, reason?: string, userId?: string, email?: string, sessionsRevoked?: number}}
 */
export function recoverOwner(db, env = process.env) {
  const email = String(env.RECOVERY_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = String(env.RECOVERY_ADMIN_PASSWORD ?? '');
  const token = String(env.RECOVERY_TOKEN ?? '').trim();

  // Opt-in: nothing configured → nothing to do.
  if (!email && !password) return { applied: false, reason: 'NOT_CONFIGURED' };

  // Half-configured is a mistake we must not swallow.
  if (!email) throw new Error('RECOVERY_ADMIN_EMAIL_MISSING');
  if (!password) throw new Error('RECOVERY_ADMIN_PASSWORD_MISSING');
  if (!EMAIL_PATTERN.test(email)) throw new Error('RECOVERY_ADMIN_EMAIL_INVALID');
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error('PASSWORD_POLICY_FAILED');

  // Existing-account-only: never create, never duplicate.
  const user = db.get('SELECT id, tenant_id, email, role FROM users WHERE lower(email)=lower(?)', email);
  if (!user) return { applied: false, reason: 'ACCOUNT_NOT_FOUND' };

  // Owner-only: never escalate a non-owner account.
  if (user.role !== 'owner') return { applied: false, reason: 'NOT_OWNER' };

  // One-time guard.
  const fingerprint = fingerprintOf(email, token);
  if (db.get('SELECT id FROM recovery_consumed WHERE fingerprint=?', fingerprint)) {
    return { applied: false, reason: 'ALREADY_APPLIED' };
  }

  const hashed = passwordHash(password);
  const timestamp = now();
  const sessionsRevoked = db.transaction(() => {
    db.run('UPDATE users SET password_hash=?, email_verified_at=? WHERE id=?', hashed, timestamp, user.id);
    // A reset invalidates every live session for the account.
    const result = db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', timestamp, user.id);
    db.run(
      'INSERT INTO recovery_consumed(id,fingerprint,email,user_id,applied_at) VALUES(?,?,?,?,?)',
      id('recovery'), fingerprint, email, user.id, timestamp,
    );
    db.run(
      'INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
      id('audit'), user.tenant_id, 'auth.owner_recovery', 'user', user.id, JSON.stringify({ email }), timestamp,
    );
    return result.changes;
  });

  return { applied: true, userId: user.id, email, sessionsRevoked };
}
