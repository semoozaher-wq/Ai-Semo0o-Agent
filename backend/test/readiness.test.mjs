/**
 * Phase L7 — Commercial-readiness probes.
 *
 * Verifies the hardened liveness/readiness contract and the capability status
 * surface that the UI now consumes:
 *   - `/health` is a liveness check that also reports version + uptime.
 *   - `/ready` fails closed (503) with structured per-dependency checks and only
 *     turns 200 when the database answers, the workspace is usable and at least
 *     one LLM provider is configured + healthy.
 *   - `/tools/status` exposes a real capability summary (live vs unwired).
 *   - env validation flags missing structured logging in production.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { validateEnv } from '../config/env.mjs';

async function fixture({ llm } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-ready-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm, codeRunner: async () => ({ status: 'completed' }) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    dir, db, queue, app, base,
    async close() { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

const get = async (base, route, token) => {
  const response = await fetch(`${base}${route}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
};

test('health endpoint reports liveness with version and uptime', async () => {
  const fx = await fixture();
  try {
    const { status, body } = await get(fx.base, '/health');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'ai-semo0o-agent-backend');
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptimeSeconds, 'number');
  } finally { await fx.close(); }
});

test('readiness fails closed (503) with structured checks when no provider is configured', async () => {
  const fx = await fixture({ llm: { status: () => [{ id: 'openai', configured: false, healthy: true }] } });
  try {
    const { status, body } = await get(fx.base, '/ready');
    assert.equal(status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.checks.database.ok, true);
    assert.equal(body.checks.workspace.ok, true);
    assert.equal(body.checks.providers.ok, false);
    assert.equal(body.checks.providers.configured, 0);
  } finally { await fx.close(); }
});

test('readiness succeeds (200) when a provider is configured and healthy', async () => {
  const fx = await fixture({ llm: { status: () => [{ id: 'openai', configured: true, healthy: true }] } });
  try {
    const { status, body } = await get(fx.base, '/ready');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.checks.providers.ok, true);
    assert.equal(body.checks.providers.configured, 1);
  } finally { await fx.close(); }
});

test('tools/status exposes a real capability summary', async () => {
  const fx = await fixture();
  try {
    const registered = await fetch(`${fx.base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ready@example.test', password: 'correct horse battery staple', tenantName: 'Ready' }),
    });
    const token = (await registered.json()).session.token;
    const { status, body } = await get(fx.base, '/tools/status', token);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.live));
    assert.ok(Array.isArray(body.unwired));
    assert.ok(Array.isArray(body.dangerous));
    assert.ok(body.summary);
    assert.equal(body.summary.live, body.live.length);
    assert.equal(body.summary.unwired, body.unwired.length);
    assert.equal(body.summary.dangerous, body.dangerous.length);
  } finally { await fx.close(); }
});

test('env validation flags missing structured logging in production', () => {
  const base = {
    NODE_ENV: 'production',
    SECRETS_MASTER_KEY: 'a'.repeat(64),
    DATABASE_FILE: '/var/lib/semo0o/agent.sqlite',
    WORKSPACE_ROOT: '/var/lib/semo0o/workspace',
    ALLOWED_ORIGIN: 'https://app.example.com',
  };
  const without = validateEnv(base);
  assert.equal(without.ok, true);
  assert.ok(without.warnings.includes('LOG_FORMAT_NOT_SET'));
  const withJson = validateEnv({ ...base, LOG_FORMAT: 'json' });
  assert.ok(!withJson.warnings.includes('LOG_FORMAT_NOT_SET'));
});
