import { storage } from '../services/storage';

/** Loads a persisted slice, returning the fallback when nothing is stored. */
export async function loadSlice<T>(key: string, fallback: T): Promise<T> {
  const value = await storage.get<T>(key);
  return value ?? fallback;
}

/** Persists a slice. Failures are swallowed so the UI never crashes. */
export async function saveSlice<T>(key: string, value: T): Promise<void> {
  try {
    await storage.set(key, value);
  } catch {
    /* persistence is best-effort */
  }
}
