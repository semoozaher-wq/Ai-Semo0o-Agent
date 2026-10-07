import { create } from 'zustand';
import { backendApi } from '../services/api/client';
import type {
  ApiToolsStatus,
  ApiModelsStatus,
  ApiBillingStatus,
  ApiReadyReport,
  ApiIntegrationsStatus,
} from '../services/api/client';

/**
 * Real, backend-reported system status.
 *
 * This store exists so the UI can show each capability and provider with its
 * ACTUAL state (configured / healthy / unwired) instead of assuming everything
 * is available. Nothing here is optimistic: every field is the last value the
 * backend returned, or `null` when it has not answered yet.
 */
export interface SystemStatusState {
  tools: ApiToolsStatus | null;
  models: ApiModelsStatus | null;
  billing: ApiBillingStatus | null;
  integrations: ApiIntegrationsStatus | null;
  ready: ApiReadyReport | null;
  readyStatus: number | null;
  loading: boolean;
  error: string | null;
  loadedAt: string | null;
  refresh(): Promise<void>;
}

export const useSystemStatusStore = create<SystemStatusState>((set) => ({
  tools: null,
  models: null,
  billing: null,
  integrations: null,
  ready: null,
  readyStatus: null,
  loading: false,
  error: null,
  loadedAt: null,
  async refresh() {
    if (!backendApi.enabled) {
      set({ loading: false, error: 'BACKEND_API_NOT_CONFIGURED', loadedAt: new Date().toISOString() });
      return;
    }
    set({ loading: true, error: null });
    try {
      await backendApi.ensureSession();
      const [tools, models, billing, readiness, integrations] = await Promise.all([
        backendApi.getToolsStatus(),
        backendApi.getModelsStatus(),
        backendApi.getBillingStatus(),
        backendApi.getReady(),
        // The connector console is independently failable: a backend that does
        // not expose /integrations/status must not blank the core status.
        backendApi.getIntegrationsStatus().catch(() => null),
      ]);
      set({
        tools,
        models,
        billing,
        integrations,
        ready: readiness.report,
        readyStatus: readiness.status,
        loading: false,
        error: null,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'SYSTEM_STATUS_FAILED',
        loadedAt: new Date().toISOString(),
      });
    }
  },
}));
