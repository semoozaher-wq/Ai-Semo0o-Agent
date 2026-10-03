import net from 'node:net';
import path from 'node:path';

export function assertWorkspacePath(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('INVALID_PATH');
  const normalized = path.posix.normalize(input.replaceAll('\\', '/'));
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error('PATH_OUTSIDE_WORKSPACE');
  return normalized;
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
export function boundedInteger(value, fallback, maximum, name) { const resolved = value ?? fallback; if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`${name}_OUT_OF_RANGE`); return resolved; }
