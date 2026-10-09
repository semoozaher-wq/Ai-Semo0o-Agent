/**
 * Deployment access gate.
 *
 * This platform is a PRIVATE application: possessing the URL must never be
 * enough to open it. Two server-side controls enforce that, independently of
 * the client UI:
 *
 *   1. `APP_ACCESS_KEY` — a shared enrolment key. When set, `POST /auth/register`
 *      refuses any request that does not present the exact key (compared in
 *      constant time). This is the "even if they have the link" gate: without
 *      the key an outsider cannot create an account, so every authenticated
 *      route stays closed to them.
 *
 *   2. `ALLOW_PUBLIC_REGISTRATION` — when not `true`, open sign-up is refused in
 *      production. Defaults to closed in production, open in dev/test so local
 *      workflows keep working.
 *
 * `REQUIRE_EMAIL_VERIFICATION` optionally withholds the session until the
 * address is verified (fail-closed enrolment for high-assurance deployments).
 *
 * The policy is pure and env-injected so it is unit-testable without a server.
 */
import { timingSafeEqual } from 'node:crypto';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function isTrue(value) {
  return TRUE_VALUES.has(String(value ?? '').trim().toLowerCase());
}

/**
 * Resolve the effective registration policy for an environment.
 * Never throws; returns a plain, serialisable description.
 */
export function registrationPolicy(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const accessKey = String(env.APP_ACCESS_KEY ?? '').trim();
  const explicit = env.ALLOW_PUBLIC_REGISTRATION === undefined || env.ALLOW_PUBLIC_REGISTRATION === ''
    ? null
    : isTrue(env.ALLOW_PUBLIC_REGISTRATION);
  // Private-by-default: production requires an explicit opt-in for open sign-up.
  const publicEnabled = explicit ?? !isProduction;
  const requiresEmailVerification = isTrue(env.REQUIRE_EMAIL_VERIFICATION);
  return {
    isProduction,
    requiresAccessKey: accessKey.length > 0,
    publicEnabled,
    requiresEmailVerification,
    // A deployment is "gated" when an outsider cannot self-serve an account.
    gated: accessKey.length > 0 || !publicEnabled,
  };
}

/** Constant-time string comparison that never short-circuits on length. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Still perform a comparison so timing does not reveal the length.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Enforce the enrolment gate for a registration attempt.
 * Throws `REGISTRATION_DISABLED` or `ACCESS_KEY_INVALID` (both → HTTP 403).
 */
export function assertRegistrationAllowed(env = process.env, input = {}) {
  const policy = registrationPolicy(env);
  if (policy.requiresAccessKey) {
    const provided = typeof input.accessKey === 'string' ? input.accessKey.trim() : '';
    if (!provided || !safeEqual(provided, String(env.APP_ACCESS_KEY ?? '').trim())) {
      throw new Error('ACCESS_KEY_INVALID');
    }
    return policy;
  }
  if (!policy.publicEnabled) throw new Error('REGISTRATION_DISABLED');
  return policy;
}

/** True when a freshly registered account must verify email before a session. */
export function emailVerificationRequired(env = process.env) {
  return isTrue(env.REQUIRE_EMAIL_VERIFICATION);
}

/** Public (non-secret) view of the policy so the client can render the gate. */
export function describeAccessPolicy(env = process.env) {
  const policy = registrationPolicy(env);
  return {
    private: policy.gated,
    registration: {
      open: policy.publicEnabled || policy.requiresAccessKey,
      requiresAccessKey: policy.requiresAccessKey,
      requiresEmailVerification: policy.requiresEmailVerification,
    },
  };
}
