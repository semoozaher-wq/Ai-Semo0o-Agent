import { AppError, Result, makeError } from '../types/common';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message = 'Operation timed out',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(makeError('TIMEOUT', message, { retryable: true })),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, error: unknown) => void;
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 3, baseDelayMs = 250, maxDelayMs = 4000, onRetry } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      onRetry?.(attempt + 1, error);
      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Wraps a promise so it never throws — returns a Result instead. */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  code = 'UNEXPECTED',
): Promise<Result<T, AppError>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error occurred';
    const detail = error instanceof Error ? error.stack : String(error);
    return { ok: false, error: makeError(code, message, { detail }) };
  }
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  waitMs = 250,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs = 250,
): (...args: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    const now = Date.now();
    const remaining = intervalMs - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = undefined;
        fn(...args);
      }, remaining);
    }
  };
}
