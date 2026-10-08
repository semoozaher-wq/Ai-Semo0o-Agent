import net from 'node:net';
import path from 'node:path';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export function assertWorkspacePath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('INVALID_PATH');
  const normalized = path.posix.normalize(input.replaceAll('\\', '/'));
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('PATH_OUTSIDE_WORKSPACE');
  return normalized;
}

// Private / reserved / loopback / link-local ranges that must never be reachable
// from a user-supplied URL (cloud metadata, internal services, ...).
const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d)\.|192\.0\.0\.|198\.18\.|198\.19\.)/;

export function isPrivateAddress(ip) {
  if (typeof ip !== 'string') return true;
  if (net.isIPv4(ip)) {
    if (PRIVATE_V4.test(ip)) return true;
    const firstOctet = Number(ip.split('.')[0]);
    return firstOctet === 0 || firstOctet >= 224; // 0.0.0.0/8, multicast, reserved
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::' || lower === '::0') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('ff')) return true;
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice('::ffff:'.length));
    return false;
  }
  return true; // unknown form -> fail closed
}

export function assertSafeUrl(input, { allowHosts = [] } = {}) {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('URL_SCHEME_NOT_ALLOWED');
  if (url.username || url.password) throw new Error('URL_CREDENTIALS_NOT_ALLOWED');
  const host = url.hostname.toLowerCase();
  if (allowHosts.length && !allowHosts.includes(host)) throw new Error('URL_HOST_NOT_ALLOWED');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || net.isIP(host)) throw new Error('SSRF_TARGET_NOT_ALLOWED');
  if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) throw new Error('PRIVATE_NETWORK_NOT_ALLOWED');
  return url;
}

/**
 * DNS-aware SSRF guard. In addition to the synchronous string checks, it resolves
 * the hostname and rejects the URL if ANY resolved address is private/reserved.
 * This closes the classic DNS-rebinding gap where a public name resolves to
 * 169.254.169.254 (cloud metadata) or an internal service.
 *
 * It returns the validated URL *and* the exact addresses that were validated, so
 * a caller can PIN the connection to those addresses (see `pinnedLookup` /
 * `pinnedRequest`) instead of letting the socket resolve the name a second time —
 * which would reopen a TOCTOU window. `resolver` is injectable for tests.
 */
export async function resolveSafeUrl(input, { allowHosts = [], resolver } = {}) {
  const url = assertSafeUrl(input, { allowHosts });
  const host = url.hostname.toLowerCase();
  if (net.isIP(host)) return { url, addresses: [host] }; // literals already rejected above
  const lookup = resolver ?? dns.lookup;
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('URL_HOST_UNRESOLVABLE');
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error('URL_HOST_UNRESOLVABLE');
  for (const record of records) {
    if (isPrivateAddress(record?.address)) throw new Error('SSRF_TARGET_NOT_ALLOWED');
  }
  return { url, addresses: records.map((record) => record.address) };
}

/** Backwards-compatible guard that returns just the validated URL. */
export async function assertSafeUrlResolved(input, options = {}) {
  return (await resolveSafeUrl(input, options)).url;
}

/**
 * A `lookup` implementation that returns ONLY the pre-validated addresses for any
 * hostname. Wiring this into a request's `lookup` option means the socket can
 * never perform its own DNS resolution, so the address that was checked is the
 * address that is connected to — the DNS-rebinding / TOCTOU fix.
 */
export function pinnedLookup(addresses) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean);
  return (hostname, options, callback) => {
    let opts = options;
    let done = callback;
    if (typeof opts === 'function') { done = opts; opts = {}; }
    const family = opts && opts.family ? Number(opts.family) : 0;
    const candidates = family ? list.filter((address) => (net.isIPv6(address) ? 6 : 4) === family) : list;
    const chosen = candidates.length ? candidates : list;
    if (!chosen.length) return done(new Error('PINNED_ADDRESS_UNAVAILABLE'));
    if (opts && opts.all) return done(null, chosen.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })));
    return done(null, chosen[0], net.isIPv6(chosen[0]) ? 6 : 4);
  };
}

const MAX_BODY_BYTES = 5_000_000;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function decodeBody(buffer, encoding) {
  const value = String(encoding || '').toLowerCase().trim();
  if (value === 'gzip') return zlib.gunzipSync(buffer);
  if (value === 'deflate') return zlib.inflateSync(buffer);
  if (value === 'br') return zlib.brotliDecompressSync(buffer);
  return buffer;
}

/**
 * Perform a single HTTP(S) GET whose connection is PINNED to `addresses` (the
 * addresses the SSRF guard validated). Redirects are intentionally NOT followed
 * here: `safeFetchText` re-validates each hop, so a redirect to a private address
 * is rejected too. Uses only Node's built-in http/https clients — no new deps.
 */
export function pinnedRequest(url, addresses, { timeoutMs = 15_000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      lookup: pinnedLookup(addresses),
      headers: { 'user-agent': 'Semo0o-Agent/1.0', 'accept-encoding': 'gzip, deflate, br', ...headers },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { request.destroy(new Error('WEB_SCRAPE_BODY_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body = decodeBody(Buffer.concat(chunks), response.headers['content-encoding']);
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: body.toString('utf8') });
        } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('WEB_SCRAPE_TIMEOUT')));
    request.on('error', reject);
    request.end();
  });
}

/**
 * SSRF-safe text fetch: resolve + validate the host (rejecting private/reserved
 * addresses), PIN the connection to the validated address, and follow redirects
 * only after re-validating each hop. This is the hardened replacement for a bare
 * `fetch(url)` after `assertSafeUrlResolved(url)`, which re-resolved DNS and was
 * therefore vulnerable to DNS rebinding (TOCTOU).
 */
export async function safeFetchText(input, { allowHosts = [], maxRedirects = 5, timeoutMs = 15_000, resolver } = {}) {
  let current = String(input);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const { url, addresses } = await resolveSafeUrl(current, { allowHosts, resolver });
    const response = await pinnedRequest(url, addresses, { timeoutMs });
    if (REDIRECT_STATUS.has(response.status) && response.headers.location) {
      current = new URL(response.headers.location, url).toString();
      continue;
    }
    return { url: url.toString(), status: response.status, headers: response.headers, body: response.body };
  }
  throw new Error('WEB_SCRAPE_TOO_MANY_REDIRECTS');
}

export function boundedInteger(value, fallback, maximum, name) { const resolved = value ?? fallback; if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${name}_OUT_OF_RANGE`); return resolved; }
