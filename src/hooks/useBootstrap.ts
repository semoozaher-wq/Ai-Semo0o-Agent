import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useChatStore } from '../store/useChatStore';
import { useAgentsStore } from '../store/useAgentsStore';
import { useStoreStore } from '../store/useStoreStore';
import { useFilesStore } from '../store/useFilesStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useAnalyticsStore } from '../store/useAnalyticsStore';
import { useAuthStore } from '../store/useAuthStore';
import type { AuthStatus } from '../store/useAuthStore';
import { runBootstrapRecovery } from '../services/chat/recovery';

/**
 * Startup orchestration for the PRIVATE app.
 *
 * Step 1 restores the session (validating any persisted token with the server).
 * Step 2 hydrates the data stores ONLY once a live session exists — so an
 * unauthenticated visitor never triggers authenticated API calls, and the gate
 * in `app/_layout.tsx` can safely render the sign-in screen instead.
 */
export function useBootstrap(): {
  ready: boolean;
  error: string | null;
  retry: () => void;
  status: AuthStatus;
} {
  const status = useAuthStore((s) => s.status);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // 1) Session restore (runs on mount and on every explicit retry).
  useEffect(() => {
    void useAuthStore.getState().restore();
  }, [attempt]);

  // 2) Hydrate the workspace stores only for an authenticated session.
  useEffect(() => {
    if (status !== 'authenticated') {
      setHydrated(false);
      return;
    }
    let cancelled = false;

    async function run() {
      try {
        await Promise.all([
          useAppStore.getState().hydrate(),
          useChatStore.getState().hydrate(),
          useAgentsStore.getState().hydrate(),
          useStoreStore.getState().hydrate(),
          useFilesStore.getState().hydrate(),
          useWorkspaceStore.getState().hydrate(),
          useAnalyticsStore.getState().hydrate(),
        ]);
        if (!cancelled) {
          setError(null);
          setHydrated(true);
          // Best-effort: sweep any chat thread left mid-stream by a crash or a
          // backend restart so the UI can offer a retry instead of spinning
          // forever. Fire-and-forget — it must never block or fail startup.
          void runBootstrapRecovery(useChatStore.getState());
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'تعذر تحميل بيانات التطبيق');
          setHydrated(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [status, attempt]);

  return {
    ready: hydrated,
    error,
    status,
    retry: () => {
      setError(null);
      setHydrated(false);
      setAttempt((value) => value + 1);
    },
  };
}
