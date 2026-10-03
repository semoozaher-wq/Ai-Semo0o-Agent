import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useChatStore } from '../store/useChatStore';
import { useAgentsStore } from '../store/useAgentsStore';
import { useStoreStore } from '../store/useStoreStore';
import { useFilesStore } from '../store/useFilesStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useAnalyticsStore } from '../store/useAnalyticsStore';

/** Hydrates persisted stores and exposes a recoverable startup state. */
export function useBootstrap(): {
  ready: boolean;
  error: string | null;
  retry: () => void;
} {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
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
          setReady(true);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'تعذر تحميل بيانات التطبيق');
          setReady(false);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return {
    ready,
    error,
    retry: () => {
      setError(null);
      setReady(false);
      setAttempt((value) => value + 1);
    },
  };
}
