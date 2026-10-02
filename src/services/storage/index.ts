/**
 * Persistence abstraction.
 *
 * Uses `localStorage` when running on web (the primary preview target) and
 * falls back to an in-memory map everywhere else. Swapping in AsyncStorage /
 * SQLite for native builds only requires implementing the `KVStore` interface.
 */

export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

class MemoryKVStore implements KVStore {
  private map = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.map.keys());
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}

class WebKVStore implements KVStore {
  constructor(private prefix = 'semo0o:') {}

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = globalThis.localStorage?.getItem(this.key(key));
      if (raw == null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      globalThis.localStorage?.setItem(this.key(key), JSON.stringify(value));
    } catch {
      /* storage may be unavailable (private mode) — degrade gracefully */
    }
  }

  async remove(key: string): Promise<void> {
    try {
      globalThis.localStorage?.removeItem(this.key(key));
    } catch {
      /* noop */
    }
  }

  async keys(): Promise<string[]> {
    try {
      const ls = globalThis.localStorage;
      if (!ls) return [];
      const out: string[] = [];
      for (let i = 0; i < ls.length; i += 1) {
        const k = ls.key(i);
        if (k && k.startsWith(this.prefix)) out.push(k.slice(this.prefix.length));
      }
      return out;
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    const all = await this.keys();
    await Promise.all(all.map((k) => this.remove(k)));
  }
}

function detectStore(): KVStore {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
      return new WebKVStore();
    }
  } catch {
    /* fall through */
  }
  return new MemoryKVStore();
}

export const storage: KVStore = detectStore();

export const STORAGE_KEYS = {
  installedAgents: 'store.installed',
  conversations: 'chat.conversations',
  messages: 'chat.messages',
  tasks: 'agents.tasks',
  files: 'files.entries',
  settings: 'app.settings',
  theme: 'app.theme',
  usage: 'analytics.usage',
} as const;
