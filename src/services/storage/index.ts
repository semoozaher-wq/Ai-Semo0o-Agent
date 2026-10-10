import AsyncStorage from '@react-native-async-storage/async-storage';
import { scopeStorageKey } from './scope';

// Account-scoping primitives live in a pure module (no storage backend, no
// react-native) so the isolation rules are unit-testable. Re-exported here so
// existing call sites that read STORAGE_KEYS from this module keep working
// unchanged.
export {
  STORAGE_KEYS,
  ACCOUNT_SCOPED_KEYS,
  ANONYMOUS_SCOPE,
  accountScopeFor,
  setAccountScope,
  getAccountScope,
  clearAccountScope,
  scopeStorageKey,
  isAccountScoped,
  hashAccountId,
} from './scope';

export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

class WebKVStore implements KVStore {
  constructor(private prefix = 'semo0o:') {}
  private key(key: string): string { return `${this.prefix}${scopeStorageKey(key)}`; }
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = globalThis.localStorage?.getItem(this.key(key));
      return raw == null ? null : JSON.parse(raw) as T;
    } catch { return null; }
  }
  async set<T>(key: string, value: T): Promise<void> {
    try { globalThis.localStorage?.setItem(this.key(key), JSON.stringify(value)); } catch { /* private mode */ }
  }
  async remove(key: string): Promise<void> { try { globalThis.localStorage?.removeItem(this.key(key)); } catch { /* noop */ } }
  async keys(): Promise<string[]> {
    try {
      const ls = globalThis.localStorage;
      if (!ls) return [];
      return Array.from({ length: ls.length }, (_, i) => ls.key(i))
        .filter((key): key is string => Boolean(key?.startsWith(this.prefix)))
        .map((key) => key.slice(this.prefix.length));
    } catch { return []; }
  }
  async clear(): Promise<void> { await Promise.all((await this.keys()).map((key) => this.remove(key))); }
}

class NativeKVStore implements KVStore {
  private prefix = 'semo0o:';
  private key(key: string): string { return `${this.prefix}${scopeStorageKey(key)}`; }
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await AsyncStorage.getItem(this.key(key));
      return raw == null ? null : JSON.parse(raw) as T;
    } catch { return null; }
  }
  async set<T>(key: string, value: T): Promise<void> {
    await AsyncStorage.setItem(this.key(key), JSON.stringify(value));
  }
  async remove(key: string): Promise<void> { await AsyncStorage.removeItem(this.key(key)); }
  async keys(): Promise<string[]> {
    return (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(this.prefix)).map((key) => key.slice(this.prefix.length));
  }
  async clear(): Promise<void> {
    for (const key of await this.keys()) await AsyncStorage.removeItem(this.key(key));
  }
}

function detectStore(): KVStore {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.localStorage) return new WebKVStore();
  } catch { /* use native storage */ }
  return new NativeKVStore();
}

export const storage: KVStore = detectStore();
