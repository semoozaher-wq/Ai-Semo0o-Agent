import { create } from 'zustand';
import { storage, STORAGE_KEYS } from '../services/storage';
import { hashString } from '../utils/id';
import { backendApi } from '../services/api/client';

export interface UsagePoint {
  date: string;
  tokens: number;
  costUsd: number;
  tasks: number;
  messages: number;
}

/**
 * Where the currently displayed usage series came from.
 * - `backend` — real tenant usage fetched from the API (may legitimately be empty).
 * - `local`   — usage recorded on this device (offline / optimistic).
 * - `sample`  — deterministic demo data shown only when no backend is configured.
 */
export type UsageSource = 'backend' | 'local' | 'sample';

interface AnalyticsState {
  usage: UsagePoint[];
  source: UsageSource;
  hydrated: boolean;
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
  record(entry: Partial<UsagePoint> & { date?: string }): void;
  reset(): Promise<void>;
}

function isoDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** Deterministic 30-day usage series so charts are populated offline (demo only). */
function seedUsage(days = 30): UsagePoint[] {
  const points: UsagePoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = isoDay(i);
    const seed = hashString(date);
    const tokens = 8_000 + (seed % 42_000);
    points.push({
      date,
      tokens,
      costUsd: Number((tokens / 1_000_000 * 6.5).toFixed(3)),
      tasks: 1 + (seed % 9),
      messages: 4 + (seed % 30),
    });
  }
  return points;
}

/**
 * Fetch the tenant's real usage series from the backend. Returns `null` when the
 * backend is not configured or unreachable (so callers can fall back to demo data),
 * and an array (possibly empty) when the backend answered authoritatively.
 */
async function fetchBackendUsage(): Promise<UsagePoint[] | null> {
  if (!backendApi.enabled) return null;
  try {
    await backendApi.ensureSession();
    const summary = await backendApi.getUsage(30);
    return (summary.daily ?? []).map((point) => ({
      date: point.date,
      tokens: point.tokens,
      costUsd: point.costUsd,
      tasks: point.runs,
      messages: point.messages,
    }));
  } catch {
    return null;
  }
}

export function computeTotals(usage: UsagePoint[]) {
  return usage.reduce(
    (acc, p) => ({
      tokens: acc.tokens + p.tokens,
      costUsd: acc.costUsd + p.costUsd,
      tasks: acc.tasks + p.tasks,
      messages: acc.messages + p.messages,
    }),
    { tokens: 0, costUsd: 0, tasks: 0, messages: 0 },
  );
}

export const useAnalyticsStore = create<AnalyticsState>((set, get) => ({
  usage: [],
  source: 'sample',
  hydrated: false,

  async hydrate() {
    const stored = await storage.get<UsagePoint[]>(STORAGE_KEYS.usage);
    if (stored && stored.length) {
      set({ usage: stored, source: 'local', hydrated: true });
      return;
    }
    const remote = await fetchBackendUsage();
    if (remote) {
      set({ usage: remote, source: 'backend', hydrated: true });
      return;
    }
    set({ usage: seedUsage(), source: 'sample', hydrated: true });
  },

  async refresh() {
    const remote = await fetchBackendUsage();
    if (remote) {
      set({ usage: remote, source: 'backend' });
      await storage.set(STORAGE_KEYS.usage, remote);
      return;
    }
    set({ usage: seedUsage(), source: 'sample' });
  },

  record(entry) {
    const date = entry.date ?? isoDay(0);
    const usage = [...get().usage];
    const idx = usage.findIndex((p) => p.date === date);
    if (idx >= 0) {
      usage[idx] = {
        ...usage[idx],
        tokens: usage[idx].tokens + (entry.tokens ?? 0),
        costUsd: usage[idx].costUsd + (entry.costUsd ?? 0),
        tasks: usage[idx].tasks + (entry.tasks ?? 0),
        messages: usage[idx].messages + (entry.messages ?? 0),
      };
    } else {
      usage.push({
        date,
        tokens: entry.tokens ?? 0,
        costUsd: entry.costUsd ?? 0,
        tasks: entry.tasks ?? 0,
        messages: entry.messages ?? 0,
      });
    }
    set({ usage, source: 'local' });
    void storage.set(STORAGE_KEYS.usage, usage);
  },

  async reset() {
    await storage.set(STORAGE_KEYS.usage, []);
    const remote = await fetchBackendUsage();
    if (remote) {
      set({ usage: remote, source: 'backend' });
      await storage.set(STORAGE_KEYS.usage, remote);
      return;
    }
    set({ usage: seedUsage(), source: 'sample' });
  },
}));
