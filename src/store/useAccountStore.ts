import { create } from 'zustand';
import { backendApi } from '../services/api/client';
import type {
  ApiAccount,
  ApiAccountDeletion,
  ApiAccountExport,
  ApiMfaSetup,
  DeleteAccountInput,
} from '../services/api/client';

/**
 * Account security state: the caller's real profile, an in-progress MFA
 * enrollment, the last data export, and the destructive-delete result.
 *
 * Nothing is optimistic. `account.mfaEnabled` is whatever `GET /me` returned,
 * `mfaSetup` only exists after the server issued a secret, and every failure is
 * surfaced as `error` rather than swallowed.
 */
export interface AccountState {
  account: ApiAccount | null;
  /** Present only while a TOTP enrollment is in progress (secret + codes). */
  mfaSetup: ApiMfaSetup | null;
  lastExport: ApiAccountExport | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  loadedAt: string | null;
  load(): Promise<void>;
  beginMfa(): Promise<ApiMfaSetup | null>;
  confirmMfa(code: string): Promise<boolean>;
  downloadExport(): Promise<ApiAccountExport | null>;
  removeAccount(input: DeleteAccountInput): Promise<ApiAccountDeletion | null>;
  clearMfaSetup(): void;
}

export const useAccountStore = create<AccountState>((set, get) => ({
  account: null,
  mfaSetup: null,
  lastExport: null,
  loading: false,
  busy: false,
  error: null,
  loadedAt: null,
  async load() {
    if (!backendApi.enabled) {
      set({ loading: false, error: 'BACKEND_API_NOT_CONFIGURED', loadedAt: new Date().toISOString() });
      return;
    }
    set({ loading: true, error: null });
    try {
      await backendApi.requireSession();
      const account = await backendApi.getAccount();
      set({ account, loading: false, error: null, loadedAt: new Date().toISOString() });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'ACCOUNT_LOAD_FAILED',
        loadedAt: new Date().toISOString(),
      });
    }
  },
  async beginMfa() {
    set({ busy: true, error: null });
    try {
      const mfaSetup = await backendApi.setupMfa();
      set({ mfaSetup, busy: false });
      return mfaSetup;
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : 'MFA_SETUP_FAILED' });
      return null;
    }
  },
  async confirmMfa(code) {
    set({ busy: true, error: null });
    try {
      const result = await backendApi.confirmMfa(code);
      set({ busy: false, mfaSetup: null });
      // Re-read the profile so the badge reflects the server's real state.
      if (result.enabled) await get().load();
      return result.enabled;
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : 'MFA_CONFIRM_FAILED' });
      return false;
    }
  },
  async downloadExport() {
    set({ busy: true, error: null });
    try {
      const lastExport = await backendApi.exportAccount();
      set({ lastExport, busy: false });
      return lastExport;
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : 'ACCOUNT_EXPORT_FAILED' });
      return null;
    }
  },
  async removeAccount(input) {
    set({ busy: true, error: null });
    try {
      const result = await backendApi.deleteAccount(input);
      set({ busy: false, account: null, mfaSetup: null, lastExport: null });
      return result;
    } catch (error) {
      set({ busy: false, error: error instanceof Error ? error.message : 'ACCOUNT_DELETE_FAILED' });
      return null;
    }
  },
  clearMfaSetup() {
    set({ mfaSetup: null });
  },
}));
