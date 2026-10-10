import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { isDefinitiveAuthRejection, restoreSessionWith } from '../src/services/api/session-restore';

// -----------------------------------------------------------------------------
// Cold-start session-restore policy.
//
// The bug being guarded against: a transient network outage (or a 5xx / CORS /
// rate-limit response) must NEVER clear the persisted session token — doing so
// silently signs the user out on a flaky connection. The token is cleared ONLY
// when the server definitively rejects it (HTTP 401 or an explicit
// session-invalid code).
//
// `session-restore.ts` is dependency-free, so the exact policy runs under
// `tsx --test`, and the final test drives it against a REAL local HTTP server.
// -----------------------------------------------------------------------------

test('isDefinitiveAuthRejection: only 401 / explicit session-invalid codes are definitive', () => {
  // Definitive rejections.
  assert.equal(isDefinitiveAuthRejection(new Error('BACKEND_401')), true);
  assert.equal(isDefinitiveAuthRejection(new Error('UNAUTHORIZED')), true);
  assert.equal(isDefinitiveAuthRejection(new Error('AUTH_REQUIRED')), true);
  assert.equal(isDefinitiveAuthRejection(new Error('INVALID_TOKEN')), true);
  assert.equal(isDefinitiveAuthRejection(new Error('SESSION_EXPIRED')), true);
  assert.equal(isDefinitiveAuthRejection(new Error('SESSION_REVOKED')), true);
  assert.equal(isDefinitiveAuthRejection(new Error('TOKEN_EXPIRED')), true);
  assert.equal(isDefinitiveAuthRejection(new Error('ACCOUNT_TOKEN_INVALID_OR_EXPIRED')), true);
});

test('isDefinitiveAuthRejection: network / 5xx / 403 / 429 are NOT definitive (token preserved)', () => {
  assert.equal(isDefinitiveAuthRejection(new TypeError('fetch failed')), false);
  assert.equal(isDefinitiveAuthRejection(new Error('Network request failed')), false);
  assert.equal(isDefinitiveAuthRejection(new Error('BACKEND_500')), false);
  assert.equal(isDefinitiveAuthRejection(new Error('BACKEND_502')), false);
  assert.equal(isDefinitiveAuthRejection(new Error('BACKEND_503')), false);
  assert.equal(isDefinitiveAuthRejection(new Error('BACKEND_403')), false, '403 is CORS/access-key, not a token rejection');
  assert.equal(isDefinitiveAuthRejection(new Error('BACKEND_429')), false, 'rate limit must not sign the user out');
  assert.equal(isDefinitiveAuthRejection(new Error('BACKEND_404')), false);
  assert.equal(isDefinitiveAuthRejection(new Error('')), false);
  assert.equal(isDefinitiveAuthRejection(undefined), false);
  assert.equal(isDefinitiveAuthRejection(null), false);
});

/** Build a deps bundle that records which lifecycle hooks were called. */
function makeDeps(token: string | null, behaviour: 'ok' | 'network' | 'server500' | 'unauthorized' | 'empty') {
  const calls = { cleared: 0, kept: 0, keptWith: null as string | null };
  return {
    calls,
    deps: {
      readToken: async () => token,
      validate: async (t: string) => {
        if (behaviour === 'network') throw new TypeError('fetch failed');
        if (behaviour === 'server500') throw new Error('BACKEND_500');
        if (behaviour === 'unauthorized') throw new Error('BACKEND_401');
        if (behaviour === 'empty') return null as never;
        return { id: 'u1', tenantId: 't1', token: t } as never;
      },
      clearSession: () => { calls.cleared += 1; },
      keepSession: (t: string) => { calls.kept += 1; calls.keptWith = t; },
    },
  };
}

test('no persisted token → "none", nothing cleared or kept', async () => {
  const { deps, calls } = makeDeps(null, 'ok');
  const result = await restoreSessionWith(deps);
  assert.equal(result.kind, 'none');
  assert.equal(calls.cleared, 0);
  assert.equal(calls.kept, 0);
});

test('valid token → "restored" and the token is neither cleared nor re-kept', async () => {
  const { deps, calls } = makeDeps('tok-1', 'ok');
  const result = await restoreSessionWith<{ id: string }>(deps);
  assert.equal(result.kind, 'restored');
  assert.equal(calls.cleared, 0);
  assert.equal(calls.kept, 0);
});

test('network failure → "unavailable" and the token is KEPT (never cleared)', async () => {
  const { deps, calls } = makeDeps('tok-net', 'network');
  const result = await restoreSessionWith(deps);
  assert.equal(result.kind, 'unavailable');
  assert.equal(calls.cleared, 0, 'a network outage must not clear the session');
  assert.equal(calls.kept, 1);
  assert.equal(calls.keptWith, 'tok-net');
});

test('server 5xx → "unavailable" and the token is KEPT', async () => {
  const { deps, calls } = makeDeps('tok-500', 'server500');
  const result = await restoreSessionWith(deps);
  assert.equal(result.kind, 'unavailable');
  assert.equal(calls.cleared, 0);
  assert.equal(calls.kept, 1);
});

test('definitive 401 → "rejected" and the token IS cleared', async () => {
  const { deps, calls } = makeDeps('tok-401', 'unauthorized');
  const result = await restoreSessionWith(deps);
  assert.equal(result.kind, 'rejected');
  assert.equal(calls.cleared, 1, 'a definitive rejection must clear the session');
  assert.equal(calls.kept, 0);
});

test('a 2xx response with no identity is treated as unavailable (token kept)', async () => {
  const { deps, calls } = makeDeps('tok-empty', 'empty');
  const result = await restoreSessionWith(deps);
  assert.equal(result.kind, 'unavailable');
  assert.equal(calls.cleared, 0);
  assert.equal(calls.kept, 1);
});

// -----------------------------------------------------------------------------
// Real HTTP round-trip: drive restoreSessionWith against a live server whose
// /auth/session endpoint returns 200 / 401 / 500, exactly like the backend.
// -----------------------------------------------------------------------------

test('restoreSessionWith against a real /auth/session endpoint', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'GET' || req.url !== '/auth/session') {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    }
    const auth = req.headers.authorization ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token === 'good') return res.end(JSON.stringify({ user: { id: 'u1', tenantId: 't1', email: 'me@test' } }));
    if (token === 'revoked') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'UNAUTHORIZED' })); }
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: 'INTERNAL' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // Mirrors BackendApiClient.request: bearer + JSON, non-2xx throws the body
  // error code (or BACKEND_<status> when the body carries none).
  const validate = async (token: string) => {
    const response = await fetch(`${base}/auth/session`, {
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String((payload as { error?: string }).error ?? `BACKEND_${response.status}`));
    return (payload as { user: { id: string } }).user;
  };

  const run = async (token: string) => {
    const calls = { cleared: 0, kept: 0 };
    const result = await restoreSessionWith<{ id: string }>({
      readToken: async () => token,
      validate,
      clearSession: () => { calls.cleared += 1; },
      keepSession: () => { calls.kept += 1; },
    });
    return { result, calls };
  };

  try {
    const good = await run('good');
    assert.equal(good.result.kind, 'restored');
    assert.equal(good.calls.cleared, 0);

    const revoked = await run('revoked');
    assert.equal(revoked.result.kind, 'rejected');
    assert.equal(revoked.calls.cleared, 1, 'a 401 from the server must clear the token');

    const down = await run('anything');
    assert.equal(down.result.kind, 'unavailable');
    assert.equal(down.calls.cleared, 0, 'a 500 from the server must NOT clear the token');
    assert.equal(down.calls.kept, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
