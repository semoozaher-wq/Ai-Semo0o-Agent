const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : decimals)} ${BYTE_UNITS[i]}`;
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1_000_000_000)
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact' }).format(value);
}

export function formatPercent(value: number, decimals = 0): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatCurrency(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  const diff = now.getTime() - then;
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  const suffix = diff >= 0 ? '' : ' (قادم)';
  if (abs < minute) return `الآن${suffix}`;
  if (abs < hour) return `منذ ${Math.round(abs / minute)} دقيقة${suffix}`;
  if (abs < day) return `منذ ${Math.round(abs / hour)} ساعة${suffix}`;
  if (abs < week) return `منذ ${Math.round(abs / day)} يوم${suffix}`;
  if (abs < month) return `منذ ${Math.round(abs / week)} أسبوع${suffix}`;
  if (abs < year) return `منذ ${Math.round(abs / month)} شهر${suffix}`;
  return `منذ ${Math.round(abs / year)} سنة${suffix}`;
}

export function formatDate(iso: string, locale = 'ar-EG'): string {
  try {
    return new Date(iso).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso.slice(0, 10);
  }
}

export function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p.charAt(0)).join('').toUpperCase();
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : plural ?? `${singular}s`;
}
