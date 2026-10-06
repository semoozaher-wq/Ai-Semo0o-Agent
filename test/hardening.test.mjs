import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../backend/db/client.mjs';
import { DistributedRateLimiter, applySecurityHeaders } from '../backend/security/http.mjs';
import { normalizeModelId, modelProvider } from '../backend/models/catalog.mjs';

test('model contract normalizes UI aliases and rejects unsupported IDs', () => {
  assert.equal(normalizeModelId('gemini-3-flash'), 'gemini-3-flash-preview');
  assert.equal(modelProvider('claude-4.5-sonnet'), 'anthropic');
  assert.throws(() => normalizeModelId('not-a-real-model'), /UNSUPPORTED_MODEL/);
});

test('distributed limiter shares a fixed window through SQLite', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-limit-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  try {
    const limiter = new DistributedRateLimiter(db, { windowMs: 60_000, max: 2 });
    assert.equal(limiter.allow('same-client'), true);
    assert.equal(limiter.allow('same-client'), true);
    assert.equal(limiter.allow('same-client'), false);
    assert.equal(limiter.allow('other-client'), true);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

function captureHeaders() {
  const headers = {};
  return { headers, setHeader: (name, value) => { headers[String(name).toLowerCase()] = value; } };
}

test('applySecurityHeaders locks down the API surface without pinning a dev host', () => {
  const response = captureHeaders();
  applySecurityHeaders(response, '', { secure: false });
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(response.headers['content-security-policy'], /default-src 'none'/);
  assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(response.headers['permissions-policy'], /camera=\(\)/);
  assert.match(response.headers['permissions-policy'], /microphone=\(\)/);
  assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(response.headers['x-permitted-cross-domain-policies'], 'none');
  assert.equal(response.headers['cache-control'], 'no-store');
  // Vary on Origin so a shared cache never cross-serves a CORS response.
  assert.equal(response.headers['vary'], 'Origin');
  // No HSTS on a plain-HTTP host, and no CORS grant without an allowed origin.
  assert.equal(response.headers['strict-transport-security'], undefined);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('applySecurityHeaders advertises HSTS and reflects the allowed origin in production', () => {
  const response = captureHeaders();
  applySecurityHeaders(response, 'https://app.example.com', { secure: true });
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  assert.equal(response.headers['access-control-allow-origin'], 'https://app.example.com');
});

test('case-insensitive auth and outbox lookups use an index instead of a full scan', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-idx-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  try {
    const plan = (sql, ...params) => db.all(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => row.detail).join(' | ');
    const loginPlan = plan('SELECT id,tenant_id,email FROM users WHERE lower(email)=lower(?)', 'a@b.com');
    assert.match(loginPlan, /USING INDEX idx_users_email_lower/, `login must use the functional index, got: ${loginPlan}`);
    assert.doesNotMatch(loginPlan, /SCAN users/, 'login must not full-scan users');

    const outboxPlan = plan('SELECT id FROM email_outbox WHERE tenant_id=? AND lower(to_email)=lower(?)', 't', 'a@b.com');
    assert.match(outboxPlan, /USING INDEX idx_email_outbox_recipient/, `outbox export must use the composite index, got: ${outboxPlan}`);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
