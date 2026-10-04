import net from 'node:net';
import path from 'node:path';
import dns from 'node:dns/promises';

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
 */
export async function assertSafeUrlResolved(input, options = {}) {
  const url = assertSafeUrl(input, options);
  const host = url.hostname.toLowerCase();
  if (net.isIP(host)) return url; // literals already rejected above
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('URL_HOST_UNRESOLVABLE');
  }
  if (!Array.isArray(records) || records.length === 0) throw new Error('URL_HOST_UNRESOLVABLE');
  for (const record of records) {
    if (isPrivateAddress(record?.address)) throw new Error('SSRF_TARGET_NOT_ALLOWED');
  }
  return url;
}

export function boundedInteger(value, fallback, maximum, name) { const resolved = value ?? fallback; if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${name}_OUT_OF_RANGE`); return resolved; }
