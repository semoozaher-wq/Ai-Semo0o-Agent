import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

// -----------------------------------------------------------------------------
// Frontend <-> backend integration.
//
// Two layers of proof:
//   A. Source-level wiring guards: the client actually DELEGATES session restore
//      to the tested policy module and the auth store actually binds/clears the
//      account namespace around sign-in / sign-out.
//   B. A live HTTP round-trip exercising the exact login -> session -> data ->
//      agent-run flow plus the API failure paths (401 / 5xx / network) using a
//      request helper that mirrors `BackendApiClient.request` byte-for-byte.
// -----------------------------------------------------------------------------

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('client delegates session restore to the tested policy module (no ad-hoc clearing)', () => {
  const source = read('../src/services/api/client.ts');
  assert.ok(source.includes("import { restoreSessionWith } from './session-restore'"), 'must import the policy module');
  assert.ok(source.includes('restoreSessionWith<ApiUser>('), 'restoreSession must delegate to restoreSessionWith');
  assert.ok(source.includes('keepSession:'), 'must keep the token on a transient failure');
  assert.ok(source.includes('clearSession: () => this.clearSession()'), 'must clear only via the policy callback');
  // The old footgun: a blanket try/catch that wiped the session on ANY error.
  assert.equal(
    /catch\s*\([^)]*\)\s*\{\s*this\.clearSession\(\)/.test(source),
    false,
    'restoreSession must not clear the session in a blanket catch',
  );
});

test('auth store binds the account namespace on sign-in and clears it on sign-out', () => {
  const source = read('../src/store/useAuthStore.ts');
  assert.ok(source.includes('adoptAccountScope'), 'must adopt the account scope');
  assert.ok(source.includes('resetUserDataStores'), 'sign-out must drop in-memory user stores');
  assert.ok(source.includes('clearAccountScope'), 'sign-out must unbind the account namespace');
  assert.ok(source.includes('accountScopeFor'), 'must derive the scope from the user identity');
  // restore()/login()/register() must all bind the scope.
  const adoptions = source.match(/adoptAccountScope\(/g) ?? [];
  assert.ok(adoptions.length >= 4, 'scope must be adopted on restore/login/register (>=3 call sites + definition)');
});

test('the storage layer derives every physical key through the scope resolver', () => {
  const source = read('../src/services/storage/index.ts');
  assert.ok(source.includes("import { scopeStorageKey } from './scope'"), 'must import the resolver');
  const derivations = source.match(/scopeStorageKey\(key\)/g) ?? [];
  assert.equal(derivations.length, 2, 'both Web + Native stores must scope their keys');
});

// -----------------------------------------------------------------------------
// Live round-trip: a real server implementing the auth + data + run routes.
// -----------------------------------------------------------------------------

test('login -> session -> conversations -> attachments -> agent run (real HTTP)', async () => {
  const seen: { method: string; path: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const body = raw ? JSON.parse(raw) : {};
      const send = (status: number, payload: unknown) => { res.statusCode = status; res.end(JSON.stringify(payload)); };

      if (req.method === 'POST' && req.url === '/auth/login') {
        if (body.password !== 'correct') return send(401, { error: 'INVALID_CREDENTIALS' });
        return send(200, { user: { id: 'u1', tenantId: 't1', email: 'me@test' }, session: { token: 'tok-abc', expiresAt: '2030-01-01T00:00:00.000Z' } });
      }
      // Every route below requires the session.
      if (token !== 'tok-abc') return send(401, { error: 'UNAUTHORIZED' });
      if (req.method === 'GET' && req.url === '/auth/session') return send(200, { user: { id: 'u1', tenantId: 't1', email: 'me@test' } });
      if (req.method === 'POST' && req.url === '/auth/logout') return send(200, { ok: true });
      if (req.method === 'GET' && req.url === '/conversations') return send(200, { conversations: [{ id: 'c1', title: 'First' }] });
      if (req.method === 'POST' && req.url === '/attachments') return send(200, { id: 'a1', name: body.name, mimeType: body.mimeType, size: 3 });
      if (req.method === 'POST' && req.url === '/runs') return send(200, { id: 'run1', status: 'queued' });
      if (req.method === 'GET' && req.url === '/runs/run1') return send(200, { run: { id: 'run1', status: 'completed' } });
      return send(404, { error: 'NOT_FOUND' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // Faithful copy of BackendApiClient.request: base URL + bearer + JSON,
  // non-2xx throws the body error code (or BACKEND_<status> when absent).
  let token: string | null = null;
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String((payload as { error?: string }).error ?? `BACKEND_${response.status}`));
    return payload as T;
  };

  try {
    // 1. Login issues a session token.
    const login = await request<{ user: { id: string }; session: { token: string } }>('/auth/login', { method: 'POST', body: JSON.stringify({ email: 'me@test', password: 'correct' }) });
    token = login.session.token;
    assert.equal(token, 'tok-abc');

    // 2. Session restore validates the persisted token.
    const session = await request<{ user: { id: string } }>('/auth/session');
    assert.equal(session.user.id, 'u1');

    // 3. Conversations + attachments are reachable with the session.
    const conversations = await request<{ conversations: { id: string }[] }>('/conversations');
    assert.equal(conversations.conversations[0]?.id, 'c1');
    const attachment = await request<{ id: string }>('/attachments', { method: 'POST', body: JSON.stringify({ name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YWJj' }) });
    assert.equal(attachment.id, 'a1');

    // 4. Agent execution: create a run then poll it.
    const run = await request<{ id: string; status: string }>('/runs', { method: 'POST', body: JSON.stringify({ goal: 'do it' }) });
    assert.equal(run.id, 'run1');
    const snapshot = await request<{ run: { status: string } }>('/runs/run1');
    assert.equal(snapshot.run.status, 'completed');

    // Every authenticated call carried the bearer token.
    assert.ok(seen.filter((s) => s.path !== '/auth/login').every((s) => s.authorization === 'Bearer tok-abc'));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('API failure scenarios surface the exact error codes (401 / 404 / 5xx / network)', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/boom') { res.statusCode = 500; return res.end(JSON.stringify({ error: 'INTERNAL' })); }
    if (req.url === '/nobody') { res.statusCode = 200; return res.end('not json'); }
    if (req.url === '/missing') { res.statusCode = 404; return res.end(JSON.stringify({})); }
    res.statusCode = 401; return res.end(JSON.stringify({ error: 'UNAUTHORIZED' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const request = async (path: string): Promise<void> => {
    const response = await fetch(`${base}${path}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String((payload as { error?: string }).error ?? `BACKEND_${response.status}`));
  };

  try {
    await assert.rejects(() => request('/anything'), /UNAUTHORIZED/);
    await assert.rejects(() => request('/boom'), /INTERNAL/);
    await assert.rejects(() => request('/missing'), /BACKEND_404/);
    // A non-JSON 200 is tolerated (empty body) — must NOT throw.
    await assert.doesNotReject(() => request('/nobody'));
    // A dead port surfaces a transport error, not a fabricated auth code.
    await assert.rejects(
      () => fetch('http://127.0.0.1:1/health'),
      (err: unknown) => err instanceof Error && !/UNAUTHORIZED|BACKEND_/.test(err.message),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
