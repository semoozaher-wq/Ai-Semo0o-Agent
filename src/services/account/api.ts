/**
 * Account operations, expressed as pure functions over an injected `request`.
 *
 * `BackendApiClient` owns the transport (base URL, bearer token, JSON encode)
 * and delegates the account endpoints here, so there is exactly ONE definition
 * of each request's path/method/body. Because this module has no react-native
 * import, the exact wire contract is unit-testable against a real HTTP server
 * without pulling in the whole RN runtime.
 */

/** The authenticated caller's profile, including the REAL MFA state. */
export interface ApiAccount {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  mfaEnabled: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
}

/** `POST /auth/mfa/setup` result: the shared secret + one-time recovery codes. */
export interface ApiMfaSetup {
  secret: string;
  recoveryCodes: string[];
  enabled: boolean;
}

/** `DELETE /me` result. `scope` is `'self'` (leave) or `'tenant'` (erase org). */
export interface ApiAccountDeletion {
  deleted: boolean;
  scope: string;
  counts?: Record<string, number>;
  purged?: unknown;
}

/** `GET /me/export` result — a self-service data export. */
export interface ApiAccountExport {
  user: { id: string; tenantId: string; email: string; role: string };
  memberships: unknown[];
  projects: unknown[];
  messages: unknown[];
  conversations: unknown[];
  chatMessages: unknown[];
  memory: unknown[];
  runs: unknown[];
  usage: unknown;
  audit: unknown[];
  outbox: unknown[];
  exportedAt: string;
  [key: string]: unknown;
}

export interface DeleteAccountInput {
  confirmEmail: string;
  scope?: 'self' | 'tenant';
  force?: boolean;
  transferOwnershipTo?: string;
}

/** The transport the client injects: `(path, init) => parsed JSON`. */
export type AccountRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function createAccountApi(request: AccountRequest) {
  return {
    /** The caller's own profile (honest MFA state for the Settings UI). */
    getAccount: async (): Promise<ApiAccount> => (await request<{ user: ApiAccount }>('/me')).user,

    /** Begin TOTP enrollment; returns the secret + recovery codes. */
    setupMfa: (): Promise<ApiMfaSetup> => request<ApiMfaSetup>('/auth/mfa/setup', { method: 'POST' }),

    /** Confirm enrollment with a code from the authenticator app. */
    confirmMfa: (code: string): Promise<{ enabled: boolean }> =>
      request<{ enabled: boolean }>('/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) }),

    /** Erase the account (`scope: 'self'`) or the whole tenant (`scope: 'tenant'`). */
    deleteAccount: (input: DeleteAccountInput): Promise<ApiAccountDeletion> =>
      request<ApiAccountDeletion>('/me', { method: 'DELETE', body: JSON.stringify(input) }),

    /** Download everything the caller owns (GDPR/CCPA self-service export). */
    exportAccount: (): Promise<ApiAccountExport> => request<ApiAccountExport>('/me/export'),
  };
}
