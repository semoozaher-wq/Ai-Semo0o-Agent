import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  buildOtpAuthUrl,
  classifyMfaCode,
  exportFilename,
  formatRecoveryCode,
  formatRecoveryCodes,
  isDeleteConfirmationValid,
  isValidMfaCode,
  normalizeMfaCode,
  summarizeExport,
} from '../src/services/account/security';
import { createAccountApi } from '../src/services/account/api';

// -----------------------------------------------------------------------------
// Account-security helpers + the exact client<->backend wire contract.
//
// The pure helpers (below) are what the Settings UI uses to build the otpauth
// URI, classify typed codes, name the export file, and gate the delete button.
// The contract test (last) drives `createAccountApi` against a REAL local HTTP
// server and asserts the precise method/path/body each operation sends — the
// same operations `BackendApiClient` delegates to. So the frontend feature is
// proven wired to the backend routes, not merely present.
// -----------------------------------------------------------------------------

test('normalizeMfaCode strips separators and upper-cases recovery codes', () => {
  assert.equal(normalizeMfaCode('123 456'), '123456');
  assert.equal(normalizeMfaCode(' 123-456 '), '123456');
  assert.equal(normalizeMfaCode('a1b2-c3d4-e5f6-0a1b'), 'A1B2C3D4E5F60A1B');
});

test('classifyMfaCode distinguishes TOTP, recovery, and invalid input', () => {
  assert.equal(classifyMfaCode('123456'), 'totp');
  assert.equal(classifyMfaCode('123 456'), 'totp');
  assert.equal(classifyMfaCode('A1B2C3D4E5F60A1B'), 'recovery');
  assert.equal(classifyMfaCode('a1b2c3d4e5f60a1b'), 'recovery');
  assert.equal(classifyMfaCode('12345'), 'invalid');
  assert.equal(classifyMfaCode('1234567'), 'invalid');
  assert.equal(classifyMfaCode('ZZZZZZZZZZZZZZZZ'), 'invalid');
  assert.equal(classifyMfaCode(''), 'invalid');
  assert.equal(isValidMfaCode('123456'), true);
  assert.equal(isValidMfaCode('nope'), false);
});

test('buildOtpAuthUrl pins the same TOTP parameters the backend verifies', () => {
  const url = buildOtpAuthUrl({ secret: 'JBSWY3DPEHPK3PXP', account: 'user@example.com' });
  assert.ok(url.startsWith('otpauth://totp/'));
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.host, 'totp');
  assert.equal(parsed.pathname, '/Semo%20AI:user%40example.com');
  assert.equal(parsed.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
  assert.equal(parsed.searchParams.get('issuer'), 'Semo AI');
  assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
});

test('recovery codes are grouped for readability', () => {
  assert.equal(formatRecoveryCode('A1B2C3D4E5F60A1B'), 'A1B2-C3D4-E5F6-0A1B');
  assert.equal(formatRecoveryCodes(['A1B2C3D4E5F60A1B', '0000111122223333']), 'A1B2-C3D4-E5F6-0A1B\n0000-1111-2222-3333');
});

test('exportFilename is stable and filesystem-safe', () => {
  const date = new Date('2024-05-01T12:00:00.000Z');
  assert.equal(exportFilename('User.Example+tag@Example.COM', date), 'semo0o-export-user-example-tag-example-com-2024-05-01.json');
  assert.equal(exportFilename('', date), 'semo0o-export-account-2024-05-01.json');
});

test('summarizeExport counts only array-valued sections', () => {
  const summary = summarizeExport({
    user: { id: 'u1' },
    runs: [1, 2, 3],
    messages: [1],
    conversations: [],
    exportedAt: '2024-01-01T00:00:00.000Z',
  });
  assert.deepEqual(summary.sections, [
    { name: 'runs', count: 3 },
    { name: 'messages', count: 1 },
    { name: 'conversations', count: 0 },
  ]);
  assert.equal(summary.totalRecords, 4);
  assert.deepEqual(summarizeExport(null), { sections: [], totalRecords: 0 });
});

test('isDeleteConfirmationValid is case- and whitespace-insensitive', () => {
  assert.equal(isDeleteConfirmationValid(' User@Example.com ', 'user@example.com'), true);
  assert.equal(isDeleteConfirmationValid('user@example.com', 'user@example.com'), true);
  assert.equal(isDeleteConfirmationValid('other@example.com', 'user@example.com'), false);
  assert.equal(isDeleteConfirmationValid('', 'user@example.com'), false);
});

test('account operations send the exact backend contract (real HTTP round-trip)', async () => {
  const seen: { method: string; path: string; body: unknown; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        path: req.url ?? '',
        body: raw ? JSON.parse(raw) : null,
        authorization: req.headers.authorization,
      });
      res.setHeader('content-type', 'application/json');
      const respond = (payload: unknown) => res.end(JSON.stringify(payload));
      if (req.method === 'GET' && req.url === '/me') {
        return respond({ user: { id: 'u1', tenantId: 't1', email: 'me@test', role: 'owner', mfaEnabled: false, emailVerifiedAt: null, createdAt: '2024-01-01T00:00:00.000Z' } });
      }
      if (req.method === 'POST' && req.url === '/auth/mfa/setup') {
        return respond({ secret: 'JBSWY3DPEHPK3PXP', recoveryCodes: ['A1B2C3D4E5F60A1B'], enabled: false });
      }
      if (req.method === 'POST' && req.url === '/auth/mfa/confirm') return respond({ enabled: true });
      if (req.method === 'DELETE' && req.url === '/me') return respond({ deleted: true, scope: 'self', counts: { users: 1 } });
      if (req.method === 'GET' && req.url === '/me/export') {
        return respond({ user: { id: 'u1', tenantId: 't1', email: 'me@test', role: 'owner' }, memberships: [], projects: [{}], messages: [], conversations: [], chatMessages: [], memory: [], runs: [], usage: {}, audit: [], outbox: [], exportedAt: '2024-01-01T00:00:00.000Z' });
      }
      res.statusCode = 404;
      return respond({ error: 'NOT_FOUND' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // A faithful copy of BackendApiClient.request: base URL + bearer + JSON.
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token', ...(init.headers ?? {}) },
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(String(payload.error ?? `BACKEND_${response.status}`));
    return payload as T;
  };

  const api = createAccountApi(request);
  try {
    const account = await api.getAccount();
    assert.equal(account.email, 'me@test');
    assert.equal(account.mfaEnabled, false);

    const setup = await api.setupMfa();
    assert.equal(setup.secret, 'JBSWY3DPEHPK3PXP');
    assert.deepEqual(setup.recoveryCodes, ['A1B2C3D4E5F60A1B']);

    assert.equal((await api.confirmMfa('123456')).enabled, true);

    const exported = await api.exportAccount();
    assert.equal(exported.projects.length, 1);

    const deleted = await api.deleteAccount({ confirmEmail: 'me@test', scope: 'self' });
    assert.equal(deleted.deleted, true);

    assert.deepEqual(
      seen.map((entry) => `${entry.method} ${entry.path}`),
      ['GET /me', 'POST /auth/mfa/setup', 'POST /auth/mfa/confirm', 'GET /me/export', 'DELETE /me'],
    );
    assert.deepEqual(seen[2]?.body, { code: '123456' });
    assert.deepEqual(seen[4]?.body, { confirmEmail: 'me@test', scope: 'self' });
    assert.ok(seen.every((entry) => entry.authorization === 'Bearer test-token'), 'every call must carry the bearer token');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
