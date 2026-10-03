import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useChatStore } from '../store/useChatStore';
import { useAgentsStore } from '../store/useAgentsStore';
import { useStoreStore } from '../store/useStoreStore';
import { useFilesStore } from '../store/useFilesStore';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useAnalyticsStore } from '../store/useAnalyticsStore';
import { aiService } from '../services/ai';
import type { ProviderConfigMap } from '../types/model';

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
        useWorkspaceStore.getState().hydrate(),
        useAnalyticsStore.getState().hydrate(),
      ]);
      const apiKeys = useAppStore.getState().settings.apiKeys;
      const configs = Object.fromEntries(
        Object.entries(apiKeys).map(([provider, apiKey]) => [provider, { apiKey }]),
      ) as ProviderConfigMap;
      aiService.configure(configs);
      if (!cancelled) setReady(true);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return { ready };
}
