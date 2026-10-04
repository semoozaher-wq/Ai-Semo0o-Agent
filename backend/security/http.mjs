export class RateLimiter {
  constructor({ windowMs = 60_000, max = 120 } = {}) { this.windowMs = windowMs; this.max = max; this.buckets = new Map(); }
  allow(key) { const now = Date.now(); const current = this.buckets.get(key); if (!current || now >= current.resetAt) { this.buckets.set(key, { count: 1, resetAt: now + this.windowMs }); return true; } if (current.count >= this.max) return false; current.count += 1; return true; }
  cleanup() { const now = Date.now(); for (const [key, bucket] of this.buckets) if (bucket.resetAt <= now) this.buckets.delete(key); }
}

/** SQLite-backed fixed window limiter: safe across API processes using the same DB. */
export class DistributedRateLimiter {
  constructor(db, { windowMs = 60_000, max = 120 } = {}) { this.db = db; this.windowMs = windowMs; this.max = max; }
  allow(key) {
    const bucket = Math.floor(Date.now() / this.windowMs);
    const resetAt = (bucket + 1) * this.windowMs;
    return this.db.transaction(() => {
      const row = this.db.get('SELECT count FROM rate_limit_buckets WHERE bucket_key=? AND bucket=?', key, bucket);
      if (row?.count >= this.max) return false;
      this.db.run('INSERT INTO rate_limit_buckets(bucket_key,bucket,count,expires_at) VALUES(?,?,1,?) ON CONFLICT(bucket_key,bucket) DO UPDATE SET count=count+1', key, bucket, new Date(resetAt).toISOString());
      return true;
    });
  }
  cleanup() { this.db.run('DELETE FROM rate_limit_buckets WHERE expires_at<?', new Date().toISOString()); }
}

export function applySecurityHeaders(response, origin = '') {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('cache-control', 'no-store');
  if (origin) response.setHeader('access-control-allow-origin', origin);
}
