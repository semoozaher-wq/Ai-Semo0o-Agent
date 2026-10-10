import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseAllowedOrigins, isOriginAllowed, resolveAllowedOrigin } from '../security/cors.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- Unit tests: pure origin resolution ------------------------------------------

test('parseAllowedOrigins splits on commas, trims, drops trailing slashes and lowercases', () => {
  assert.deepEqual(parseAllowedOrigins('https://App.Vercel.app/, https://b.example.com ,'), [
    'https://app.vercel.app',
    'https://b.example.com',
  ]);
  assert.deepEqual(parseAllowedOrigins(''), []);
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(123), []);
});

test('isOriginAllowed matches a single origin exactly and ignores cosmetic differences', () => {
  const raw = 'https://app.vercel.app';
  assert.equal(isOriginAllowed(raw, 'https://app.vercel.app'), true);
  // Case + trailing slash on the request side must still match.
  assert.equal(isOriginAllowed(raw, 'HTTPS://APP.VERCEL.APP/'), true);
  // A trailing slash on the CONFIG side must not break every request.
  assert.equal(isOriginAllowed('https://app.vercel.app/', 'https://app.vercel.app'), true);
  // Whitespace around a list entry must not break every request.
  assert.equal(isOriginAllowed('  https://app.vercel.app  ', 'https://app.vercel.app'), true);
  // Different host / scheme / port are still rejected.
  assert.equal(isOriginAllowed(raw, 'https://evil.example.com'), false);
  assert.equal(isOriginAllowed(raw, 'http://app.vercel.app'), false);
  assert.equal(isOriginAllowed(raw, 'https://app.vercel.app:8443'), false);
});

test('isOriginAllowed supports a comma-separated allow-list', () => {
  const raw = 'https://app.vercel.app,https://admin.example.com';
  assert.equal(isOriginAllowed(raw, 'https://app.vercel.app'), true);
  assert.equal(isOriginAllowed(raw, 'https://admin.example.com'), true);
  assert.equal(isOriginAllowed(raw, 'https://other.example.com'), false);
});

test('isOriginAllowed honours a single-label host wildcard (Vercel previews)', () => {
  const raw = 'https://*.vercel.app';
  assert.equal(isOriginAllowed(raw, 'https://ai-semo0o-agent.vercel.app'), true);
  assert.equal(isOriginAllowed(raw, 'https://preview-123.vercel.app'), true);
  // The wildcard never crosses a dot, so a deeper subdomain is NOT covered.
  assert.equal(isOriginAllowed(raw, 'https://a.b.vercel.app'), false);
  // And it must not leak to a different registrable domain.
  assert.equal(isOriginAllowed(raw, 'https://vercel.app.evil.com'), false);
});

test('isOriginAllowed never honours a bare "*" (fail closed)', () => {
  assert.equal(isOriginAllowed('*', 'https://app.vercel.app'), false);
  assert.equal(isOriginAllowed('*', 'https://evil.example.com'), false);
  // A wildcard entry mixed with a real origin still only allows the real one.
  assert.equal(isOriginAllowed('*, https://app.vercel.app', 'https://app.vercel.app'), true);
  assert.equal(isOriginAllowed('*, https://app.vercel.app', 'https://evil.example.com'), false);
});

test('isOriginAllowed rejects missing / malformed request origins', () => {
  const raw = 'https://app.vercel.app';
  assert.equal(isOriginAllowed(raw, undefined), false);
  assert.equal(isOriginAllowed(raw, ''), false);
  assert.equal(isOriginAllowed(raw, 'null'), false);
  assert.equal(isOriginAllowed(raw, 'not-a-url'), false);
});

test('resolveAllowedOrigin echoes the request origin when allowed, else empty', () => {
  const raw = 'https://app.vercel.app';
  assert.equal(resolveAllowedOrigin(raw, 'https://app.vercel.app'), 'https://app.vercel.app');
  assert.equal(resolveAllowedOrigin(raw, 'https://evil.example.com'), '');
  assert.equal(resolveAllowedOrigin('', 'https://app.vercel.app'), '');
});

// --- Live test: the real server must emit correct CORS headers -------------------

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForLine(stream, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for server output; saw: ${buffer}`)); }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (predicate(line)) { cleanup(); resolve(line.trim()); return; }
      }
    };
    const cleanup = () => { clearTimeout(timer); stream.off('data', onData); };
    stream.on('data', onData);
  });
}

test('live server enforces a multi-origin CORS allow-list on preflight and actual requests', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'semo0o-cors-'));
  const port = await getFreePort();
  const child = spawn(process.execPath, ['--experimental-sqlite', 'backend/server.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      SECRETS_MASTER_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
      DATABASE_FILE: path.join(tmp, 'db', 'agent.sqlite'),
      WORKSPACE_ROOT: path.join(tmp, 'workspace'),
      // Exact origin + a trailing-slash entry + a wildcard entry.
      ALLOWED_ORIGIN: 'https://ai-semo0o-agent.vercel.app, https://admin.example.com/, https://*.preview.dev',
      PUBLIC_APP_URL: 'https://ai-semo0o-agent.vercel.app',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const base = `http://127.0.0.1:${port}`;
  try {
    await mkdir(path.join(tmp, 'workspace'), { recursive: true });
    await waitForLine(child.stdout, (l) => l.includes('backend listening on'));

    // Preflight from the canonical origin -> 204 with the origin echoed back.
    const okPreflight = await fetch(`${base}/auth/login`, {
      method: 'OPTIONS',
      headers: { origin: 'https://ai-semo0o-agent.vercel.app', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    assert.equal(okPreflight.status, 204);
    assert.equal(okPreflight.headers.get('access-control-allow-origin'), 'https://ai-semo0o-agent.vercel.app');
    assert.match(okPreflight.headers.get('access-control-allow-methods') ?? '', /POST/);

    // Preflight from a SECOND configured origin (the entry had a trailing slash).
    const secondPreflight = await fetch(`${base}/auth/login`, { method: 'OPTIONS', headers: { origin: 'https://admin.example.com' } });
    assert.equal(secondPreflight.status, 204);
    assert.equal(secondPreflight.headers.get('access-control-allow-origin'), 'https://admin.example.com');

    // Preflight from a wildcard-matched origin.
    const wildcardPreflight = await fetch(`${base}/auth/login`, { method: 'OPTIONS', headers: { origin: 'https://pr-42.preview.dev' } });
    assert.equal(wildcardPreflight.status, 204);
    assert.equal(wildcardPreflight.headers.get('access-control-allow-origin'), 'https://pr-42.preview.dev');

    // Preflight from a NON-allowed origin -> denied, and crucially NO ACAO header.
    const deniedPreflight = await fetch(`${base}/auth/login`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } });
    assert.equal(deniedPreflight.status, 403);
    assert.equal(deniedPreflight.headers.get('access-control-allow-origin'), null);

    // A real (non-preflight) request from an allowed origin still carries ACAO.
    const okGet = await fetch(`${base}/health`, { headers: { origin: 'https://ai-semo0o-agent.vercel.app' } });
    assert.equal(okGet.status, 200);
    assert.equal(okGet.headers.get('access-control-allow-origin'), 'https://ai-semo0o-agent.vercel.app');

    // A real request from a denied origin is rejected with no ACAO.
    const deniedGet = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example.com' } });
    assert.equal(deniedGet.status, 403);
    assert.equal(deniedGet.headers.get('access-control-allow-origin'), null);

    // A request with NO Origin (native app / server-to-server) is unaffected.
    const noOrigin = await fetch(`${base}/health`);
    assert.equal(noOrigin.status, 200);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    await rm(tmp, { recursive: true, force: true });
  }
});
