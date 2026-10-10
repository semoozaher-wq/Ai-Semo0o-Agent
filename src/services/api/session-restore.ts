/**
 * Cold-start session-restore policy (pure + injectable).
 *
 * The client must NEVER discard a persisted session token merely because the
 * network is down or the server is unhealthy — doing so silently signs the user
 * out on a flaky connection and forces a re-login. A token is cleared ONLY when
 * the server *definitively* rejects it: an HTTP 401, or an explicit
 * session-invalid error code.
 *
 * This module is dependency-free (no react-native, no fetch) so the exact policy
 * is unit-testable in isolation, and `BackendApiClient.restoreSession()` simply
 * supplies the real token reader / validator / setters.
 */

/**
 * Error codes the backend uses to say a session is expired/revoked/invalid.
 * Mirrors `backend/auth/security.mjs` + the HTTP status map in
 * `backend/server.mjs` (`UNAUTHORIZED` → 401). Kept in sync deliberately.
 */
const DEFINITIVE_AUTH_CODES: ReadonlySet<string> = new Set<string>([
  'UNAUTHORIZED',
  'AUTH_REQUIRED',
  'INVALID_TOKEN',
  'INVALID_SESSION',
  'SESSION_EXPIRED',
  'SESSION_INVALID',
  'SESSION_REVOKED',
  'TOKEN_EXPIRED',
  'TOKEN_INVALID',
  'ACCOUNT_TOKEN_INVALID_OR_EXPIRED',
]);

/**
 * True only when the server has DEFINITIVELY rejected the token, i.e. the
 * session is expired/revoked/invalid and keeping it would be wrong.
 *
 * Deliberately narrow: a network failure (a thrown `TypeError`), a 5xx, a 429,
 * a CORS rejection (403) or a malformed body are all treated as NON-definitive,
 * so the token is preserved and the session can be re-validated later.
 */
export function isDefinitiveAuthRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (!message) return false;
  // The transport surfaces a non-2xx status as `BACKEND_<status>` when the body
  // carries no error code. Only 401 is an unambiguous token rejection.
  const status = /^BACKEND_(\d{3})$/.exec(message);
  if (status) return Number(status[1]) === 401;
  return DEFINITIVE_AUTH_CODES.has(message);
}

export interface RestoreDeps<User> {
  /** Read the persisted token (never the password). */
  readToken(): Promise<string | null>;
  /** Validate a token against the server (`GET /auth/session`); throws on failure. */
  validate(token: string): Promise<User>;
  /** Drop the token + in-memory identity (definitive rejection only). */
  clearSession(): void;
  /** Keep the token in memory but mark the identity unresolved (transient failure). */
  keepSession(token: string): void;
}

export type RestoreResult<User> =
  | { kind: 'restored'; user: User }
  | { kind: 'none' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' };

/**
 * Resolve the persisted session. Returns:
 *   - `restored`    — the server confirmed a live session;
 *   - `none`        — no token was persisted;
 *   - `rejected`    — the server definitively rejected the token (it was cleared);
 *   - `unavailable` — the network/server failed (the token was KEPT).
 */
export async function restoreSessionWith<User>(
  deps: RestoreDeps<User>,
): Promise<RestoreResult<User>> {
  const token = await deps.readToken();
  if (!token) return { kind: 'none' };
  try {
    const user = await deps.validate(token);
    if (user == null) {
      // A 2xx with no identity is a server contract violation, not a rejection:
      // keep the token so a later, healthy response can still restore it.
      deps.keepSession(token);
      return { kind: 'unavailable' };
    }
    return { kind: 'restored', user };
  } catch (error) {
    if (isDefinitiveAuthRejection(error)) {
      deps.clearSession();
      return { kind: 'rejected' };
    }
    deps.keepSession(token);
    return { kind: 'unavailable' };
  }
}
