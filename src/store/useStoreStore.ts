import { create } from 'zustand';
import { AgentPermission, InstalledAgent } from '../types/agent';
import { StoreStats, storeService } from '../services/store';

interface StoreState {
  installed: InstalledAgent[];
  stats: StoreStats | null;
  loading: boolean;
  hydrated: boolean;
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
  install(agentId: string): Promise<void>;
  uninstall(agentId: string): Promise<void>;
  update(agentId: string): Promise<void>;
  setEnabled(agentId: string, enabled: boolean): Promise<void>;
  grantPermission(agentId: string, permission: AgentPermission): Promise<void>;
  revokePermission(agentId: string, permission: AgentPermission): Promise<void>;
  recordRun(agentId: string): Promise<void>;
  isInstalled(agentId: string): boolean;
  reset(): Promise<void>;
}

export const useStoreStore = create<StoreState>((set, get) => ({
  installed: [],
  stats: null,
  loading: false,
  hydrated: false,

  async hydrate() {
    await get().refresh();
    set({ hydrated: true });
  },

  async refresh() {
    set({ loading: true });
    const [installed, stats] = await Promise.all([
      storeService.listInstalled(),
      storeService.stats(),
    ]);
    set({ installed, stats, loading: false });
  },

  async install(agentId) {
    await storeService.install(agentId);
    await get().refresh();
  },

  async uninstall(agentId) {
    await storeService.uninstall(agentId);
    await get().refresh();
  },

  async update(agentId) {
    await storeService.update(agentId);
    await get().refresh();
  },

  async setEnabled(agentId, enabled) {
    await storeService.setEnabled(agentId, enabled);
    await get().refresh();
  },

  async grantPermission(agentId, permission) {
    await storeService.grantPermission(agentId, permission);
    await get().refresh();
  },

  async revokePermission(agentId, permission) {
    await storeService.revokePermission(agentId, permission);
    await get().refresh();
  },

  async recordRun(agentId) {
    await storeService.recordRun(agentId);
    await get().refresh();
  },

  isInstalled(agentId) {
    return get().installed.some((a) => a.agentId === agentId);
  },

  async reset() {
    await storeService.reset();
    await get().refresh();
  },
}));
