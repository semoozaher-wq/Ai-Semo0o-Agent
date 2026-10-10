// Test-only environment shim.
//
// Under Node there is no `localStorage`, so the storage layer would fall back to
// react-native AsyncStorage, whose web build references `window` and rejects
// asynchronously. Providing an in-memory `localStorage` here makes `detectStore()`
// select the web backend, so store persistence in tests becomes a harmless
// in-memory write instead of an unhandled rejection. It must be imported FIRST
// (see the test files that import the stores) so it runs before any store module.

const store = new Map<string, string>();

const localStorageShim = {
  get length(): number { return store.size; },
  key(index: number): string | null { return Array.from(store.keys())[index] ?? null; },
  getItem(key: string): string | null { return store.has(String(key)) ? store.get(String(key)) ?? null : null; },
  setItem(key: string, value: string): void { store.set(String(key), String(value)); },
  removeItem(key: string): void { store.delete(String(key)); },
  clear(): void { store.clear(); },
};

const g = globalThis as unknown as { localStorage?: unknown; window?: unknown };
if (!g.localStorage) g.localStorage = localStorageShim;
if (!g.window) g.window = globalThis;

export {};
