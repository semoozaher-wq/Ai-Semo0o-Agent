export class RateLimiter {
  constructor({ windowMs = 60_000, max = 120 } = {}) { this.windowMs = windowMs; this.max = max; this.buckets = new Map(); }
  allow(key) {
    const now = Date.now(); const current = this.buckets.get(key);
    if (!current || now >= current.resetAt) { this.buckets.set(key, { count: 1, resetAt: now + this.windowMs }); return true; }
    if (current.count >= this.max) return false;
    current.count += 1; return true;
  }
  cleanup() { const now = Date.now(); for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key); }
}
export function applySecurityHeaders(response, origin = '') {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('cache-control', 'no-store');
  if (origin) response.setHeader('access-control-allow-origin', origin);
}
