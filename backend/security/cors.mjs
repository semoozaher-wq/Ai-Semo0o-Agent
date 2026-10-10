/**
 * CORS origin resolution (pure + unit-testable).
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * The backend is a public API consumed by a SEPARATELY-hosted single-page app
 * (the Expo web bundle on Vercel), so every browser call is cross-origin and
 * depends on a correct `Access-Control-Allow-Origin` response header. When that
 * header is missing (or does not match the page's Origin) the browser refuses to
 * hand the response to JavaScript and surfaces a generic **"Failed to fetch"** —
 * for login, tasks and chat alike, because they all share the same transport.
 *
 * The previous policy accepted EXACTLY ONE origin, compared with strict string
 * equality:
 *
 *     const origin = process.env.ALLOWED_ORIGIN ?? '';
 *     applySecurityHeaders(response, origin && request.headers.origin === origin ? origin : '');
 *     if (request.headers.origin && origin && request.headers.origin !== origin) throw ...;
 *
 * That is brittle in three real, production-observable ways:
 *   1. Vercel serves the SAME app from a production domain, per-PR/preview
 *      domains and any custom domain — a single entry cannot cover them.
 *   2. A trailing slash or stray whitespace in the env value
 *      (`https://app.vercel.app/`) never equals the browser's Origin
 *      (`https://app.vercel.app`), so EVERY request is rejected.
 *   3. When `ALLOWED_ORIGIN` is unset, no header is emitted at all, so every
 *      browser request fails the same way (the server still boots — the missing
 *      value is only a warning, see backend/config/env.mjs).
 *
 * This module accepts a COMMA-SEPARATED allow-list and normalises each entry
 * (trim, drop trailing slashes, lowercase) before matching the request Origin
 * case-insensitively. A single host label may be written as a `*` wildcard
 * (e.g. `https://*.vercel.app`) so Vercel preview deployments work without
 * listing every generated URL. A bare `*` is NEVER honoured: it is treated as
 * "not an origin", so such a request is rejected — matching `assertEnv()`'s
 * production ban on the wildcard (ALLOWED_ORIGIN_WILDCARD_FORBIDDEN).
 *
 * The module is dependency-free so the exact policy is unit-testable without
 * booting the server.
 */

/** Split a raw `ALLOWED_ORIGIN` value into normalised origins (no trailing slash). */
export function parseAllowedOrigins(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
}

/** True when `value` is a usable absolute http(s) origin (never a bare `*`). */
function isUsableOrigin(value) {
  if (!value || value === '*') return false;
  return /^https?:\/\/[^\s]+$/i.test(value);
}

/** Compile an allow-list entry into a matcher. `*` matches one host label. */
function toMatcher(allowed) {
  if (!allowed.includes('*')) return (origin) => origin === allowed;
  // Escape every regex metacharacter (including `*`), then turn the escaped `\*`
  // back into a single-label wildcard. `[^.]+` keeps the wildcard inside one
  // host label (it never crosses a `.` or a `/`), so `https://*.vercel.app`
  // matches `https://x.vercel.app` but not `https://a.b.vercel.app`.
  const escaped = allowed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '[^.]+');
  const pattern = new RegExp(`^${escaped}$`);
  return (origin) => pattern.test(origin);
}

/**
 * True when `requestOrigin` is permitted by the raw `ALLOWED_ORIGIN` value.
 * Normalises both sides (trim, trailing slashes, lowercase) so a cosmetic typo
 * in the env value can no longer break every request.
 */
export function isOriginAllowed(raw, requestOrigin) {
  if (typeof requestOrigin !== 'string') return false;
  const origin = requestOrigin.trim().replace(/\/+$/, '').toLowerCase();
  if (!isUsableOrigin(origin)) return false;
  for (const allowed of parseAllowedOrigins(raw)) {
    if (!isUsableOrigin(allowed)) continue;
    if (toMatcher(allowed)(origin)) return true;
  }
  return false;
}

/**
 * Resolve the value to echo in `Access-Control-Allow-Origin`: the request's own
 * Origin when it is allowed (browsers require an exact echo), otherwise `''`
 * (no header is emitted, so the browser blocks the response — fail closed).
 */
export function resolveAllowedOrigin(raw, requestOrigin) {
  return isOriginAllowed(raw, requestOrigin) ? requestOrigin : '';
}
