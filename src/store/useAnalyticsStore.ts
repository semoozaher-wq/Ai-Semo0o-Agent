import { create } from 'zustand';
import { storage, STORAGE_KEYS } from '../services/storage';
import { hashString } from '../utils/id';

export interface UsagePoint {
  date: string;
  tokens: number;
  costUsd: number;
  tasks: number;
  messages: number;
}

interface AnalyticsState {
  usage: UsagePoint[];
  hydrated: boolean;
  hydrate(): Promise<void>;
  record(entry: Partial<UsagePoint> & { date?: string }): void;
  reset(): Promise<void>;
}

function isoDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().slice(0, 10);
}

/** Deterministic 30-day usage series so charts are populated offline. */
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
  hydrated: false,

  async hydrate() {
    const stored = await storage.get<UsagePoint[]>(STORAGE_KEYS.usage);
    set({ usage: stored && stored.length ? stored : seedUsage(), hydrated: true });
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
    set({ usage });
    void storage.set(STORAGE_KEYS.usage, usage);
  },

  async reset() {
    const usage = seedUsage();
    set({ usage });
    await storage.set(STORAGE_KEYS.usage, usage);
  },
}));
