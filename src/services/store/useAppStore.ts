import { create } from 'zustand';
import { ProviderId } from '../types/model';
import { ThemeMode } from '../theme';
import { storage, STORAGE_KEYS } from '../services/storage';
import { DEFAULT_MODEL_ID } from '../data/models';

export interface AppSettings {
  themeMode: ThemeMode;
  rtl: boolean;
  language: 'ar' | 'en';
  activeModel: string;
  defaultAgentId?: string;
  apiKeys: Partial<Record<ProviderId, string>>;
  telemetry: boolean;
  haptics: boolean;
  autoRun: boolean;
  onboarded: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  themeMode: 'dark',
  rtl: true,
  language: 'ar',
  activeModel: DEFAULT_MODEL_ID,
  apiKeys: {},
  telemetry: true,
  haptics: true,
  autoRun: false,
  onboarded: true,
};

interface AppState {
  settings: AppSettings;
  hydrated: boolean;
  hydrate(): Promise<void>;
  update(patch: Partial<AppSettings>): void;
  setThemeMode(mode: ThemeMode): void;
  toggleTheme(): void;
  setActiveModel(id: string): void;
  setApiKey(provider: ProviderId, key: string): void;
  reset(): Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,

  async hydrate() {
    const saved = await storage.get<Partial<AppSettings>>(STORAGE_KEYS.settings);
    set({
      settings: { ...DEFAULT_SETTINGS, ...(saved ?? {}), apiKeys: {} },
      hydrated: true,
    });
  },

  update(patch) {
    const settings = { ...get().settings, ...patch };
    settings.apiKeys = {};
    set({ settings });
    void storage.set(STORAGE_KEYS.settings, settings);
  },

  setThemeMode(mode) {
    get().update({ themeMode: mode });
  },

  toggleTheme() {
    get().update({
      themeMode: get().settings.themeMode === 'dark' ? 'light' : 'dark',
    });
  },

  setActiveModel(id) {
    get().update({ activeModel: id });
  },

  setApiKey(provider, key) {
    void provider;
    void key;
  },

  async reset() {
    set({ settings: DEFAULT_SETTINGS });
    await storage.remove(STORAGE_KEYS.settings);
  },
}));
