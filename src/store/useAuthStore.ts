import { create } from 'zustand';
import { backendApi } from '../services/api/client';
import type { ApiUser } from '../services/api/client';
import { AUTH_MESSAGES, humanizeAuthError } from '../services/api/auth-errors';

/**
 * Authentication gate state.
 *
 * The app is PRIVATE: nothing renders until `status === 'authenticated'`. This
 * store owns the cold-start restore, sign-in, sign-up (with the deployment's
 * access key), and sign-out. It never fabricates a session — `restore()` only
 * trusts a token the server confirms via `GET /auth/session`.
 */
export type AuthStatus = 'loading' | 'anonymous' | 'authenticated';

export interface AccessPolicy {
  private: boolean;
  registration: { open: boolean; requiresAccessKey: boolean; requiresEmailVerification: boolean };
}

export interface AuthState {
  status: AuthStatus;
  user: ApiUser | null;
  policy: AccessPolicy | null;
  error: string | null;
  busy: boolean;
  /** True when the last login needs a TOTP code to complete. */
  mfaRequired: boolean;
  restore(): Promise<void>;
  refreshPolicy(): Promise<void>;
  login(input: { email: string; password: string; mfaCode?: string }): Promise<boolean>;
  register(input: { email: string; password: string; tenantName?: string; accessKey?: string }): Promise<{ ok: boolean; verificationRequired: boolean }>;
  logout(): Promise<void>;
  clearError(): void;
}


export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  policy: null,
  error: null,
  busy: false,
  mfaRequired: false,

  async restore() {
    set({ status: 'loading', error: null });
    if (!backendApi.enabled) {
      set({ status: 'anonymous', user: null, error: 'BACKEND_API_NOT_CONFIGURED' });
      return;
    }
    try {
      const user = await backendApi.restoreSession();
      set({ status: user ? 'authenticated' : 'anonymous', user, error: null });
      void get().refreshPolicy();
    } catch (error) {
      set({ status: 'anonymous', user: null, error: humanizeAuthError(error) });
    }
  },

  async refreshPolicy() {
    if (!backendApi.enabled) return;
    try {
      const policy = await backendApi.getAccessPolicy();
      set({ policy });
    } catch { /* policy is advisory; the server still enforces the gate */ }
  },

  async login(input) {
    set({ busy: true, error: null, mfaRequired: false });
    try {
      const { user } = await backendApi.login(input);
      set({ status: 'authenticated', user, busy: false, error: null });
      return true;
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      set({ busy: false, status: 'anonymous', error: humanizeAuthError(error), mfaRequired: code === 'MFA_REQUIRED' });
      return false;
    }
  },

  async register(input) {
    set({ busy: true, error: null });
    try {
      const result = await backendApi.register(input);
      const verificationRequired = Boolean(result.verificationRequired);
      // Fail-closed enrolment: no session until the address is verified.
      if (!result.session) {
        set({ busy: false, status: 'anonymous', error: verificationRequired ? (AUTH_MESSAGES.EMAIL_VERIFICATION_REQUIRED ?? null) : null });
        return { ok: false, verificationRequired };
      }
      set({ status: 'authenticated', user: result.user, busy: false, error: null });
      return { ok: true, verificationRequired };
    } catch (error) {
      set({ busy: false, status: 'anonymous', error: humanizeAuthError(error) });
      return { ok: false, verificationRequired: false };
    }
  },

  async logout() {
    try { await backendApi.logout(); } catch { /* revoke is best-effort */ }
    backendApi.clearSession();
    set({ status: 'anonymous', user: null, error: null, mfaRequired: false });
  },

  clearError() {
    set({ error: null });
  },
}));
