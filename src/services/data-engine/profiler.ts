/**
 * Dataset profiler + anomaly detector.
 *
 * Pure, dependency-free statistics used by the data-analysis agent and the
 * analytics screens. Operates on in-memory row objects so it works fully
 * offline in the preview build.
 */

export type ColumnType = 'numeric' | 'categorical' | 'datetime' | 'boolean';

export interface ColumnProfile {
  name: string;
  type: ColumnType;
  count: number;
  missing: number;
  missingPct: number;
  unique: number;
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  std?: number;
  topValues?: { value: string; count: number }[];
}

export interface Outlier {
  column: string;
  row: number;
  value: number;
  z: number;
}

export interface Correlation {
  a: string;
  b: string;
  r: number;
}

export interface DatasetProfile {
  rows: number;
  columns: number;
  numericColumns: number;
  categoricalColumns: number;
  missingPct: number;
  anomalies: number;
  profiles: ColumnProfile[];
  outliers: Outlier[];
  correlations: Correlation[];
}

export type Row = Record<string, unknown>;

/* ----------------------------- math helpers ------------------------------ */

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance =
    values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : sorted[mid] ?? 0;
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const denom = Math.sqrt(da * db);
  return denom === 0 ? 0 : num / denom;
}

/* ----------------------------- inference -------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/;

function inferType(values: unknown[]): ColumnType {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (present.length === 0) return 'categorical';
  if (present.every((v) => typeof v === 'boolean')) return 'boolean';
  if (present.every((v) => typeof v === 'number' && Number.isFinite(v)))
    return 'numeric';
  if (
    present.every(
      (v) =>
        (typeof v === 'number' && Number.isFinite(v)) ||
        (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))),
    )
  )
    return 'numeric';
  if (present.every((v) => typeof v === 'string' && ISO_DATE.test(v)))
    return 'datetime';
  return 'categorical';
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  return Number(v);
}

/* ----------------------------- profiling -------------------------------- */

export function profileColumn(name: string, values: unknown[]): ColumnProfile {
  const count = values.length;
  const present = values.filter(
    (v) => v !== null && v !== undefined && v !== '',
  );
  const missing = count - present.length;
  const type = inferType(values);
  const unique = new Set(present.map((v) => String(v))).size;

  const profile: ColumnProfile = {
    name,
    type,
    count,
    missing,
    missingPct: count === 0 ? 0 : (missing / count) * 100,
    unique,
  };

  if (type === 'numeric') {
    const nums = present.map(toNumber).filter((n) => Number.isFinite(n));
    profile.min = Math.min(...nums);
    profile.max = Math.max(...nums);
    profile.mean = mean(nums);
    profile.median = median(nums);
    profile.std = stdDev(nums);
  } else if (type === 'categorical' || type === 'boolean') {
    const freq = new Map<string, number>();
    present.forEach((v) => {
      const key = String(v);
      freq.set(key, (freq.get(key) ?? 0) + 1);
    });
    profile.topValues = Array.from(freq.entries())
      .map(([value, c]) => ({ value, count: c }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  return profile;
}

export function detectAnomalies(values: number[], threshold = 3): Outlier[] {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < 3) return [];
  const m = mean(clean);
  const sd = stdDev(clean);
  if (sd === 0) return [];
  const out: Outlier[] = [];
  values.forEach((v, row) => {
    if (!Number.isFinite(v)) return;
    const z = (v - m) / sd;
    if (Math.abs(z) >= threshold) {
      out.push({ column: '', row, value: v, z: Number(z.toFixed(2)) });
    }
  });
  return out;
}

export function profileDataset(rows: Row[]): DatasetProfile {
  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((k) => set.add(k));
      return set;
    }, new Set<string>()),
  );

  const profiles = columns.map((col) =>
    profileColumn(
      col,
      rows.map((r) => r[col]),
    ),
  );

  const numericProfiles = profiles.filter((p) => p.type === 'numeric');
  const outliers: Outlier[] = [];
  numericProfiles.forEach((p) => {
    const nums = rows.map((r) => toNumber(r[p.name]));
    detectAnomalies(nums).forEach((o) =>
      outliers.push({ ...o, column: p.name }),
    );
  });

  const correlations: Correlation[] = [];
  for (let i = 0; i < numericProfiles.length; i += 1) {
    for (let j = i + 1; j < numericProfiles.length; j += 1) {
      const pi = numericProfiles[i];
      const pj = numericProfiles[j];
      if (!pi || !pj) continue;
      const a = rows.map((r) => toNumber(r[pi.name]));
      const b = rows.map((r) => toNumber(r[pj.name]));
      const r = pearson(a, b);
      if (Math.abs(r) >= 0.5) {
        correlations.push({
          a: pi.name,
          b: pj.name,
          r: Number(r.toFixed(2)),
        });
      }
    }
  }
  correlations.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  const totalCells = rows.length * Math.max(columns.length, 1);
  const totalMissing = profiles.reduce((acc, p) => acc + p.missing, 0);

  return {
    rows: rows.length,
    columns: columns.length,
    numericColumns: numericProfiles.length,
    categoricalColumns: profiles.filter(
      (p) => p.type === 'categorical' || p.type === 'boolean',
    ).length,
    missingPct: totalCells === 0 ? 0 : (totalMissing / totalCells) * 100,
    anomalies: outliers.length,
    profiles,
    outliers,
    correlations,
  };
}

/** Deterministic demo dataset so the profiler is demonstrable offline. */
export function seedDataset(size = 240): Row[] {
  const regions = ['الرياض', 'جدة', 'الدمام', 'مكة', 'المدينة'];
  const channels = ['ويب', 'جوال', 'متجر', 'شريك'];
  const rows: Row[] = [];
  for (let i = 0; i < size; i += 1) {
    const base = 40 + ((i * 37) % 160);
    const spend = base * 1.8 + ((i * 13) % 90);
    const spike = i % 53 === 0 ? 400 : 0; // injected anomaly
    rows.push({
      id: i + 1,
      region: regions[i % regions.length],
      channel: channels[i % channels.length],
      revenue: Math.round(base * 100 + spike),
      orders: base % 60,
      spend: Math.round(spend),
      satisfaction: Number((3 + ((i * 7) % 20) / 10).toFixed(1)),
      date: new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10),
    });
  }
  return rows;
}
