/**
 * First-owner bootstrap from environment variables.
 *
 * Why this exists
 * ---------------
 * The platform is a PRIVATE application: in production open sign-up is closed
 * (`ALLOW_PUBLIC_REGISTRATION` defaults to false) and a deployment may not set
 * `APP_ACCESS_KEY`. In that posture there is deliberately NO HTTP path to create
 * an account — which is exactly right for outsiders, but it also means the
 * operator needs a way to create the very FIRST account.
 *
 * `scripts/create-admin.mjs` covers the "run a command on the host / Render
 * Shell" case. This module covers the case where the operator would rather not
 * open a shell at all: set two environment variables in the host dashboard and
 * the first owner is created automatically on boot.
 *
 * Safety rules (fail-closed, never destructive):
 *   - Does nothing unless BOTH BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD
 *     are set (opt-in; the default posture is untouched).
 *   - Acts ONLY when the users table is completely empty. On a live install with
 *     any existing account it is a no-op, so it can never overwrite or escalate
 *     an existing user, and leaving the variables set is harmless.
 *   - Enforces the same 12-character password policy as self-service sign-up.
 *   - Marks the address verified so the account can sign in even when the
 *     deployment requires email verification.
 *   - Never logs the password.
 *
 * The password therefore lives in the host's secret store, not in the database
 * in plaintext and not in any log line. Operators are encouraged to remove the
 * two variables once the first owner exists.
 */
import { createUser } from './security.mjs';
import { now } from '../db/client.mjs';

const MIN_PASSWORD_LENGTH = 12;

/**
 * @returns {{created: boolean, reason?: string, user?: {id:string,email:string,role:string}}}
 */
export function bootstrapFirstOwner(db, env = process.env) {
  const email = String(env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim();
  const password = String(env.BOOTSTRAP_ADMIN_PASSWORD ?? '');

  // Opt-in: nothing configured → nothing to do.
  if (!email && !password) return { created: false, reason: 'NOT_CONFIGURED' };

  // Half-configured is a mistake we must not swallow: the operator clearly meant
  // to bootstrap an account, so surface the exact missing piece.
  if (!email) throw new Error('BOOTSTRAP_ADMIN_EMAIL_MISSING');
  if (!password) throw new Error('BOOTSTRAP_ADMIN_PASSWORD_MISSING');
  if (!email.includes('@')) throw new Error('BOOTSTRAP_ADMIN_EMAIL_INVALID');
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error('PASSWORD_POLICY_FAILED');

  // Never touch a database that already has accounts.
  const row = db.get('SELECT COUNT(*) AS n FROM users');
  if (Number(row?.n ?? 0) > 0) return { created: false, reason: 'USERS_EXIST' };

  const user = createUser(db, { email, password, tenantName: `${email} workspace` });
  db.run('UPDATE users SET email_verified_at=? WHERE id=?', now(), user.id);
  return { created: true, user: { id: user.id, email: user.email, role: user.role } };
}
