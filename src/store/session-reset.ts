/**
 * Sign-out / account-switch teardown.
 *
 * Storage keys are account-scoped (see `src/services/storage/scope.ts`), so a
 * different account can never READ another user's persisted slice. This module
 * closes the remaining gap: the in-memory zustand state and module-level caches
 * (the agent project cache, the store's install cache, the workspace singleton)
 * must be dropped too, otherwise a stale conversation/task/file list would still
 * be rendered after a sign-out until the next hydration overwrote it.
 *
 * Persisted data is deliberately NOT deleted here — it stays under the account's
 * own namespace so the same user gets it back on their next sign-in.
 */

import { useChatStore, resetChatProjectCache } from './useChatStore';
import { useAgentsStore } from './useAgentsStore';
import { useFilesStore } from './useFilesStore';
import { useAnalyticsStore } from './useAnalyticsStore';
import { useStoreStore } from './useStoreStore';
import { useWorkspaceStore } from './useWorkspaceStore';
import { useAccountStore } from './useAccountStore';
import { useCreationStore } from './useCreationStore';
import { storeService } from '../services/store';
import { workspaceService, emptyWorkspace } from '../services/workspace';

/** Reset every user-owned store + cache to its signed-out state. */
export function resetUserDataStores(): void {
  // Chat — abort any in-flight stream first, then drop the threads.
  useChatStore.getState().stop();
  useChatStore.setState({ conversations: [], messages: {}, activeId: null, streaming: false, hydrated: false });
  resetChatProjectCache();

  // Agent tasks.
  useAgentsStore.setState({ tasks: [], logs: {}, runningId: null, approvalRequest: null, hydrated: false });

  // Files workspace.
  useFilesStore.setState({ files: [], report: null, audit: null, auditScore: 100, analysis: null, scanning: false, sample: false, hydrated: false });

  // Usage analytics.
  useAnalyticsStore.setState({ usage: [], source: 'sample', hydrated: false });

  // Installed agents (store) — drop the in-memory cache so the next account
  // re-reads its own scoped install state.
  storeService.forget();
  useStoreStore.setState({ installed: [], stats: null, loading: false, hydrated: false });

  // Virtual workspace singleton.
  workspaceService.setWorkspace(emptyWorkspace());
  useWorkspaceStore.setState({ workspace: emptyWorkspace(), hydrated: false, busy: false, error: undefined, lastExport: undefined });

  // Account security panel.
  useAccountStore.setState({ account: null, mfaSetup: null, lastExport: null, loading: false, busy: false, error: null, loadedAt: null });

  // Creation studio (also stops any active job poll).
  useCreationStore.getState().reset();
}
