export function groupBy<T, K extends string | number>(
  items: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {} as Record<K, T[]>);
}

export function uniqueBy<T, K>(items: T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export function sortBy<T>(
  items: T[],
  keyFn: (item: T) => number | string,
  direction: 'asc' | 'desc' = 'asc',
): T[] {
  const sorted = [...items].sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1;
    if (ka > kb) return 1;
    return 0;
  });
  return direction === 'asc' ? sorted : sorted.reverse();
}

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export function sum(items: number[]): number {
  return items.reduce((acc, n) => acc + n, 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function range(count: number, start = 0): number[] {
  return Array.from({ length: count }, (_, i) => start + i);
}

export function toggle<T>(items: T[], value: T): T[] {
  return items.includes(value)
    ? items.filter((item) => item !== value)
    : [...items, value];
}

export function firstMatch<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  return items.find(predicate);
}
