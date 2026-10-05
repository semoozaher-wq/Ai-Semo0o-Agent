/**
 * Backend base-URL resolution.
 *
 * `EXPO_PUBLIC_BACKEND_URL` is inlined by Expo/Metro at BUILD time. In production
 * the deployed bundle was found to contain a *malformed* value — the markdown link
 * string `[https://printer-turbo.onrender.com](https://printer-turbo.onrender.com)`
 * instead of the real backend `https://ai-semo0o-agent-3.onrender.com`. A value
 * like that makes `fetch()` throw (`Failed to parse URL`), which surfaced in the UI
 * as "فشل التشغيل التنفيذي عبر الـBackend" with 0 steps.
 *
 * To make the app resilient to a wrong/absent/malformed build-time value we:
 *   1. accept ONLY a bare absolute http(s) URL (trim + drop trailing slashes),
 *   2. reject anything that needed unwrapping (markdown links, brackets, quotes)
 *      as a misconfiguration, and
 *   3. fall back to the known-good production backend when the value is unusable.
 *
 * This is a code-level fix, not a runtime workaround: any future misconfiguration
 * of the Vercel env var degrades gracefully to the correct backend instead of
 * breaking agent runs.
 */

// The deployed production backend. Used only when the build-time value is missing
// or unusable. This is a public URL (not a secret), so it is safe to inline.
export const DEFAULT_BACKEND_URL = 'https://ai-semo0o-agent-3.onrender.com';

// Read the build-time value STATICALLY. Expo/Metro inlines `process.env.EXPO_PUBLIC_*`
// by replacing the exact expression `process.env.EXPO_PUBLIC_BACKEND_URL` with a
// string literal. Reading it through a variable (e.g. `env.EXPO_PUBLIC_BACKEND_URL`)
// would defeat that inlining, so the static access is intentional.
const CONFIGURED_BACKEND_URL: string | undefined =
  typeof process !== 'undefined' ? process.env.EXPO_PUBLIC_BACKEND_URL : undefined;

/**
 * Normalise a raw backend URL into a clean origin (no trailing slash), or return
 * `''` when the value is empty or not a usable bare http(s) URL.
 *
 * Only a BARE absolute http(s) URL is trusted. Anything that required unwrapping
 * (markdown link syntax, brackets, quotes, whitespace) is treated as a
 * misconfiguration and rejected, so the caller falls back to the safe default.
 * This is deliberate: the production bundle inlined the markdown string
 * `[https://printer-turbo.onrender.com](https://printer-turbo.onrender.com)` — a
 * WRONG backend. Unwrapping it would have silently kept pointing at the wrong
 * host, so a non-bare value is rejected instead of "recovered".
 */
export function normalizeBackendUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  if (!value) return '';

  // Bare URL only: no whitespace, brackets, parentheses, angle brackets or quotes.
  // This rejects markdown links (`[url](url)`) and other paste artefacts.
  if (!/^https?:\/\/[^\s<>"'[\]()]+$/i.test(value)) return '';

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname) return '';
    // Return the origin plus any explicit base path, without a trailing slash.
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path}`;
  } catch {
    return '';
  }
}

/**
 * Resolve the backend base URL actually used by the API client: the normalised
 * build-time value when usable, otherwise the known-good production default.
 * The `configured` argument exists for tests; production uses the inlined value.
 */
export function resolveBackendUrl(configured: unknown = CONFIGURED_BACKEND_URL): string {
  return normalizeBackendUrl(configured) || DEFAULT_BACKEND_URL;
}
