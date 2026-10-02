import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useChatStore } from '../store/useChatStore';
import { useAgentsStore } from '../store/useAgentsStore';
import { useStoreStore } from '../store/useStoreStore';
import { useFilesStore } from '../store/useFilesStore';
import { useAnalyticsStore } from '../store/useAnalyticsStore';

/**
 * Hydrates every persisted store exactly once when the app mounts.
 *
 * Returns `ready` so screens can render skeletons until the local data
 * (conversations, tasks, install state, workspace, usage) is available.
 */
export function useBootstrap(): { ready: boolean } {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      await Promise.all([
        useAppStore.getState().hydrate(),
        useChatStore.getState().hydrate(),
        useAgentsStore.getState().hydrate(),
        useStoreStore.getState().hydrate(),
        useFilesStore.getState().hydrate(),
        useAnalyticsStore.getState().hydrate(),
      ]);
      if (!cancelled) setReady(true);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return { ready };
}
