// Bounded-concurrency helpers.
//
// A managed embedding/reindex pass over a large project can issue hundreds of
// network calls. Running them strictly sequentially is slow; running them all at
// once can exhaust sockets and trip provider rate limits. `mapWithConcurrency`
// runs at most `limit` tasks in flight while preserving input order in the
// result, and it never rejects on the first error: it collects every outcome so
// the caller can decide how to report partial failure.

const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 32;

export function resolveConcurrency(value, fallback = DEFAULT_LIMIT) {
  const resolved = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < 1) return fallback;
  return Math.min(resolved, MAX_LIMIT);
}

/**
 * Map over `items` calling `worker(item, index)` with at most `limit` promises
 * in flight. Resolves to an array of `{ status: 'fulfilled', value }` or
 * `{ status: 'rejected', reason }` entries, in input order.
 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.from(items ?? []);
  const size = resolveConcurrency(limit);
  const results = new Array(list.length);
  let cursor = 0;

  async function run() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(list[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(size, list.length); i += 1) runners.push(run());
  await Promise.all(runners);
  return results;
}
