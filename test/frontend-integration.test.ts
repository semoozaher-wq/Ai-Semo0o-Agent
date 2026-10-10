import './support/web-storage-shim';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { BackendApiClient, backendApi, createMemoryTokenStorage } from '../src/services/api/client';
import type { ApiSession, ApiUser } from '../src/services/api/client';
import type { RestoreResult } from '../src/services/api/session-restore';
import { accountScopeFor, clearAccountScope, getAccountScope } from '../src/services/storage';
import { useAuthStore } from '../src/store/useAuthStore';
import type { AccessPolicy } from '../src/store/useAuthStore';

// -----------------------------------------------------------------------------
// Frontend <-> backend integration.
//
// Unlike a simulation, these tests drive the REAL `BackendApiClient` (and the
// REAL `useAuthStore`) against a live local HTTP server. They cover the full
// login -> restore -> conversations -> attachments -> agent-run -> logout flow,
// the three failure classes (401 / 5xx / network outage), and the two store
// invariants that were previously broken:
//   * a TRANSIENT restore failure must NOT clear the session or go anonymous;
//   * the account scope must be bound BEFORE the status flips to authenticated.
//
// The client's platform token store is swapped for an in-memory one via its
// constructor seam, so no device (react-native / SecureStore) is required.
// -----------------------------------------------------------------------------

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const TOKEN = 'tok-abc';
const USER: ApiUser = { id: 'u1', tenantId: 't1', email: 'me@test', role: 'owner' };
const POLICY: AccessPolicy = {
  private: true,
  registration: { open: false, requiresAccessKey: true, requiresEmailVerification: false },
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A faithful stand-in for the backend's auth + data + run routes. */
function createBackend(): { server: Server; seen: { method: string; path: string; authorization: string | undefined }[] } {
  const seen: { method: string; path: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = req.url ?? '';
      seen.push({ method: req.method ?? '', path: url, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (status: number, payload: unknown) => { res.statusCode = status; res.end(JSON.stringify(payload)); };

      if (req.method === 'POST' && url === '/auth/login') {
        if (body.password !== 'correct') return send(401, { error: 'INVALID_CREDENTIALS' });
        return send(200, { user: USER, session: { token: TOKEN, expiresAt: '2030-01-01T00:00:00.000Z' } });
      }
      // Every route below requires the session.
      if (token !== TOKEN) return send(401, { error: 'UNAUTHORIZED' });
      if (req.method === 'GET' && url === '/auth/session') return send(200, { user: USER });
      if (req.method === 'POST' && url === '/auth/logout') return send(200, { ok: true });
      if (req.method === 'GET' && url === '/conversations') {
        return send(200, { conversations: [{ id: 'c1', title: 'First', mode: 'chat', status: 'active', created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' }] });
      }
      if (req.method === 'POST' && url === '/attachments') {
        return send(200, { id: 'a1', name: body.name, mimeType: body.mimeType, kind: 'document', sizeBytes: 3, sha256: 'sha', createdAt: '2025-01-01T00:00:00.000Z' });
      }
      if (req.method === 'POST' && url === '/runs') return send(200, { runId: 'run1', taskId: 'task1', status: 'queued' });
      if (req.method === 'GET' && url === '/runs/run1') return send(200, { status: 'completed', result: { final: 'done' } });
      return send(404, { error: 'NOT_FOUND' });
    });
  });
  return { server, seen };
}

// -----------------------------------------------------------------------------
// A. Full happy-path flow against the real client.
// -----------------------------------------------------------------------------

test('real BackendApiClient: login -> restore -> conversations -> attachments -> run -> logout', async () => {
  const { server, seen } = createBackend();
  const base = await listen(server);
  const storage = createMemoryTokenStorage();
  const client = new BackendApiClient(base, storage);
  try {
    // 1. Login issues a session and persists the token.
    const login = await client.login({ email: 'me@test', password: 'correct' });
    assert.equal(login.session.token, TOKEN);
    assert.equal(login.user.id, 'u1');
    assert.equal(client.authenticated, true);
    assert.equal(await storage.read(), TOKEN, 'login must persist the token');

    // 2. Authenticated data calls carry the bearer token.
    const conversations = await client.listConversations();
    assert.equal(conversations.conversations[0]?.id, 'c1');
    const attachment = await client.uploadAttachment({ name: 'a.txt', mimeType: 'text/plain', dataBase64: 'YWJj' });
    assert.equal(attachment.id, 'a1');
    const run = await client.createRun({ goal: 'do it' });
    assert.equal(run.runId, 'run1');
    const snapshot = await client.getRun('run1');
    assert.equal(snapshot.status, 'completed');
    assert.ok(seen.filter((s) => s.path !== '/auth/login').every((s) => s.authorization === `Bearer ${TOKEN}`), 'every authenticated call must carry the bearer token');

    // 3. A FRESH client restores the persisted session (cold start).
    const cold = new BackendApiClient(base, createMemoryTokenStorage(await storage.read()));
    const restored = await cold.restoreSessionResult();
    assert.equal(restored.kind, 'restored');
    if (restored.kind === 'restored') assert.equal(restored.user.id, 'u1');

    // 4. Logout revokes and clears the session.
    await client.logout();
    assert.equal(client.authenticated, false);
    assert.equal(await storage.read(), null, 'logout must clear the persisted token');
  } finally {
    await close(server);
  }
});

test('real BackendApiClient: invalid credentials surface INVALID_CREDENTIALS and start no session', async () => {
  const { server } = createBackend();
  const base = await listen(server);
  const client = new BackendApiClient(base, createMemoryTokenStorage());
  try {
    await assert.rejects(() => client.login({ email: 'me@test', password: 'wrong' }), /INVALID_CREDENTIALS/);
    assert.equal(client.authenticated, false);
  } finally {
    await close(server);
  }
});

// -----------------------------------------------------------------------------
// B. The three failure classes. The whole point: 401 is DEFINITIVE (drop the
//    session), 5xx and a network outage are TRANSIENT (KEEP the session).
// -----------------------------------------------------------------------------

test('real BackendApiClient: 401 on restore is a DEFINITIVE rejection (token cleared)', async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.statusCode = 401; res.end(JSON.stringify({ error: 'UNAUTHORIZED' })); });
  const base = await listen(server);
  const storage = createMemoryTokenStorage('expired-token');
  const client = new BackendApiClient(base, storage);
  try {
    const result = await client.restoreSessionResult();
    assert.equal(result.kind, 'rejected');
    assert.equal(await storage.read(), null, 'a definitive rejection must clear the token');
    assert.equal(client.authenticated, false);
  } finally {
    await close(server);
  }
});

test('real BackendApiClient: 5xx on restore is TRANSIENT (token kept, session not dropped)', async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.statusCode = 503; res.end(JSON.stringify({ error: 'SERVICE_UNAVAILABLE' })); });
  const base = await listen(server);
  const storage = createMemoryTokenStorage('live-token');
  const client = new BackendApiClient(base, storage);
  try {
    const result = await client.restoreSessionResult();
    assert.equal(result.kind, 'unavailable');
    assert.equal(await storage.read(), 'live-token', 'a transient failure must keep the token');
  } finally {
    await close(server);
  }
});

test('real BackendApiClient: a network outage on restore is TRANSIENT (token kept)', async () => {
  // Port 1 is closed, so `fetch` rejects with a transport error.
  const storage = createMemoryTokenStorage('live-token');
  const client = new BackendApiClient('http://127.0.0.1:1', storage);
  const result = await client.restoreSessionResult();
  assert.equal(result.kind, 'unavailable');
  assert.equal(await storage.read(), 'live-token', 'a network outage must keep the token');
});

test('real BackendApiClient: a 5xx on a data call surfaces the error (not a fabricated auth code)', async () => {
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.statusCode = 500; res.end(JSON.stringify({ error: 'INTERNAL' })); });
  const base = await listen(server);
  const client = new BackendApiClient(base, createMemoryTokenStorage('tok'));
  try {
    await assert.rejects(() => client.listConversations(), /INTERNAL/);
  } finally {
    await close(server);
  }
});

test('real BackendApiClient: a network outage on a data call throws a transport error', async () => {
  const client = new BackendApiClient('http://127.0.0.1:1', createMemoryTokenStorage('tok'));
  await assert.rejects(
    () => client.listConversations(),
    (err: unknown) => err instanceof Error && !/UNAUTHORIZED|BACKEND_/.test(err.message),
  );
});

// -----------------------------------------------------------------------------
// C. Store-level invariants (driven through the REAL useAuthStore).
// -----------------------------------------------------------------------------

type BackendOverrides = {
  restoreSessionResult?: () => Promise<RestoreResult<ApiUser>>;
  register?: (input: { email: string; password: string; tenantName?: string; accessKey?: string }) => Promise<{ user: ApiUser; session: ApiSession | null; verificationRequired?: boolean }>;
  login?: (input: { email: string; password: string; mfaCode?: string }) => Promise<{ user: ApiUser; session: ApiSession }>;
  getAccessPolicy?: () => Promise<AccessPolicy>;
};

/** Patch the shared client singleton for one test, then restore it. */
async function withBackend<T>(overrides: BackendOverrides, run: () => Promise<T>): Promise<T> {
  const saved = {
    restoreSessionResult: backendApi.restoreSessionResult,
    register: backendApi.register,
    login: backendApi.login,
    getAccessPolicy: backendApi.getAccessPolicy,
  };
  if (overrides.restoreSessionResult) backendApi.restoreSessionResult = overrides.restoreSessionResult;
  if (overrides.register) backendApi.register = overrides.register;
  if (overrides.login) backendApi.login = overrides.login;
  if (overrides.getAccessPolicy) backendApi.getAccessPolicy = overrides.getAccessPolicy;
  try {
    return await run();
  } finally {
    backendApi.restoreSessionResult = saved.restoreSessionResult;
    backendApi.register = saved.register;
    backendApi.login = saved.login;
    backendApi.getAccessPolicy = saved.getAccessPolicy;
  }
}

/** Capture the bound account scope at the exact moment the status becomes authenticated. */
async function scopeWhenAuthenticated(run: () => Promise<unknown>): Promise<string | null | undefined> {
  let captured: string | null | undefined;
  const unsubscribe = useAuthStore.subscribe((state) => {
    if (state.status === 'authenticated' && captured === undefined) captured = getAccountScope();
  });
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return captured;
}

test('restore(): a transient failure keeps the session and NEVER goes anonymous', async () => {
  await withBackend({ restoreSessionResult: async () => ({ kind: 'unavailable' }), getAccessPolicy: async () => POLICY }, async () => {
    useAuthStore.setState({ status: 'loading', user: null, error: null });
    await useAuthStore.getState().restore();
    const state = useAuthStore.getState();
    assert.equal(state.status, 'unavailable');
    assert.notEqual(state.status, 'anonymous');
    assert.equal(state.user, null);
    assert.ok(state.error && state.error.length > 0, 'must surface a clear message');
  });
});

test('restore(): a definitive rejection (expired session) goes anonymous and unbinds the scope', async () => {
  await withBackend({ restoreSessionResult: async () => ({ kind: 'rejected' }), getAccessPolicy: async () => POLICY }, async () => {
    clearAccountScope();
    useAuthStore.setState({ status: 'loading', user: null, error: null });
    await useAuthStore.getState().restore();
    assert.equal(useAuthStore.getState().status, 'anonymous');
    assert.equal(getAccountScope(), null);
  });
});

test('restore(): no persisted session goes anonymous', async () => {
  await withBackend({ restoreSessionResult: async () => ({ kind: 'none' }), getAccessPolicy: async () => POLICY }, async () => {
    useAuthStore.setState({ status: 'loading', user: null, error: null });
    await useAuthStore.getState().restore();
    assert.equal(useAuthStore.getState().status, 'anonymous');
  });
});

test('restore(): a confirmed session authenticates and binds the account scope', async () => {
  await withBackend({ restoreSessionResult: async () => ({ kind: 'restored', user: USER }), getAccessPolicy: async () => POLICY }, async () => {
    clearAccountScope();
    useAuthStore.setState({ status: 'loading', user: null, error: null });
    await useAuthStore.getState().restore();
    const state = useAuthStore.getState();
    assert.equal(state.status, 'authenticated');
    assert.equal(state.user?.id, 'u1');
    assert.equal(getAccountScope(), accountScopeFor(USER));
  });
});

test('restore(): a safe retry after a transient failure succeeds without a re-login', async () => {
  let mode: 'unavailable' | 'restored' = 'unavailable';
  await withBackend({
    restoreSessionResult: async () => (mode === 'unavailable' ? { kind: 'unavailable' } : { kind: 'restored', user: USER }),
    getAccessPolicy: async () => POLICY,
  }, async () => {
    clearAccountScope();
    useAuthStore.setState({ status: 'loading', user: null, error: null });
    await useAuthStore.getState().restore();
    assert.equal(useAuthStore.getState().status, 'unavailable');
    mode = 'restored';
    await useAuthStore.getState().restore(); // the retry
    assert.equal(useAuthStore.getState().status, 'authenticated');
  });
});

test('register(): the account scope is bound BEFORE the status flips to authenticated', async () => {
  const newUser: ApiUser = { id: 'u9', tenantId: 't9', email: 'new@test', role: 'owner' };
  await withBackend({
    register: async () => ({ user: newUser, session: { token: 'tok-new', expiresAt: '2030-01-01T00:00:00.000Z' }, verificationRequired: false }),
    getAccessPolicy: async () => POLICY,
  }, async () => {
    clearAccountScope();
    useAuthStore.setState({ status: 'anonymous', user: null, error: null });
    const captured = await scopeWhenAuthenticated(() => useAuthStore.getState().register({ email: 'new@test', password: 'x'.repeat(12) }));
    assert.equal(useAuthStore.getState().status, 'authenticated');
    assert.equal(captured, accountScopeFor(newUser), 'the scope must already be bound when the status becomes authenticated');
  });
});

test('login(): the account scope is bound BEFORE the status flips to authenticated', async () => {
  await withBackend({
    login: async () => ({ user: USER, session: { token: TOKEN, expiresAt: '2030-01-01T00:00:00.000Z' } }),
    getAccessPolicy: async () => POLICY,
  }, async () => {
    clearAccountScope();
    useAuthStore.setState({ status: 'anonymous', user: null, error: null });
    const captured = await scopeWhenAuthenticated(() => useAuthStore.getState().login({ email: 'me@test', password: 'correct' }));
    assert.equal(useAuthStore.getState().status, 'authenticated');
    assert.equal(captured, accountScopeFor(USER), 'the scope must already be bound when the status becomes authenticated');
  });
});

// -----------------------------------------------------------------------------
// D. Source-level wiring guards (belt-and-suspenders for the invariants above).
// -----------------------------------------------------------------------------

test('client delegates session restore to the tested policy module (no ad-hoc clearing)', () => {
  const source = read('../src/services/api/client.ts');
  assert.ok(source.includes("import { restoreSessionWith } from './session-restore'"), 'must import the policy module');
  assert.ok(source.includes('restoreSessionWith<ApiUser>('), 'restore must delegate to restoreSessionWith');
  assert.ok(source.includes('keepSession:'), 'must keep the token on a transient failure');
  assert.ok(source.includes('clearSession: () => this.clearSession()'), 'must clear only via the policy callback');
  // The old footgun: a blanket try/catch that wiped the session on ANY error.
  assert.equal(
    /catch\s*\([^)]*\)\s*\{\s*this\.clearSession\(\)/.test(source),
    false,
    'restore must not clear the session in a blanket catch',
  );
});

test('auth store distinguishes expiry from a transient failure and orders the scope before auth', () => {
  const source = read('../src/store/useAuthStore.ts');
  assert.ok(source.includes("status: 'unavailable'"), 'must expose a dedicated transient status');
  assert.ok(source.includes('restoreSessionResult'), 'restore must consume the rich result');
  assert.ok(source.includes('adoptAccountScope'), 'must adopt the account scope');
  assert.ok(source.includes('resetUserDataStores'), 'an account switch must drop in-memory user stores');
  assert.ok(source.includes('clearAccountScope'), 'sign-out must unbind the account namespace');
  // register() must bind the scope BEFORE flipping the status.
  const registerBody = source.slice(source.indexOf('async register('), source.indexOf('async verifyEmail('));
  assert.ok(registerBody.indexOf('adoptAccountScope(') < registerBody.indexOf("status: 'authenticated'"), 'register must bind the scope before authenticated');
});

test('the storage layer derives every physical key through the scope resolver', () => {
  const source = read('../src/services/storage/index.ts');
  assert.ok(source.includes("import { scopeStorageKey } from './scope'"), 'must import the resolver');
  const derivations = source.match(/scopeStorageKey\(key\)/g) ?? [];
  assert.equal(derivations.length, 2, 'both Web + Native stores must scope their keys');
});
