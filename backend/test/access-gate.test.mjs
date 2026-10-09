import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import {
  assertRegistrationAllowed,
  describeAccessPolicy,
  emailVerificationRequired,
  registrationPolicy,
} from '../auth/access.mjs';

// ---------------------------------------------------------------------------
// Private-app access gate.
//
// Two layers are covered:
//   1. The pure policy functions (env-injected, no server) — the contract.
//   2. The real HTTP routes (`GET /auth/policy`, `POST /auth/register`,
//      `POST /auth/login`) — proving an outsider with the URL cannot
//      self-provision an account, and that a gated deployment fails closed.
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple';

// --- 1. pure policy --------------------------------------------------------

test('registration policy: production is private-by-default', () => {
  const policy = registrationPolicy({ NODE_ENV: 'production' });
  assert.equal(policy.gated, true);
  assert.equal(policy.publicEnabled, false);
  assert.equal(policy.requiresAccessKey, false);
});

test('registration policy: development stays open for local workflows', () => {
  const policy = registrationPolicy({ NODE_ENV: 'development' });
  assert.equal(policy.gated, false);
  assert.equal(policy.publicEnabled, true);
});

test('registration policy: an access key gates any environment', () => {
  const policy = registrationPolicy({ NODE_ENV: 'development', APP_ACCESS_KEY: 'k'.repeat(16) });
  assert.equal(policy.requiresAccessKey, true);
  assert.equal(policy.gated, true);
});

test('registration policy: explicit opt-in reopens production', () => {
  const policy = registrationPolicy({ NODE_ENV: 'production', ALLOW_PUBLIC_REGISTRATION: 'true' });
  assert.equal(policy.publicEnabled, true);
  assert.equal(policy.gated, false);
});

test('assertRegistrationAllowed throws REGISTRATION_DISABLED in a closed production', () => {
  assert.throws(() => assertRegistrationAllowed({ NODE_ENV: 'production' }, {}), /REGISTRATION_DISABLED/);
});

test('assertRegistrationAllowed throws ACCESS_KEY_INVALID for a missing or wrong key', () => {
  const env = { NODE_ENV: 'production', APP_ACCESS_KEY: 'the-real-key-123456' };
  assert.throws(() => assertRegistrationAllowed(env, {}), /ACCESS_KEY_INVALID/);
  assert.throws(() => assertRegistrationAllowed(env, { accessKey: 'nope' }), /ACCESS_KEY_INVALID/);
});

test('assertRegistrationAllowed passes with the exact key', () => {
  const env = { NODE_ENV: 'production', APP_ACCESS_KEY: 'the-real-key-123456' };
  const policy = assertRegistrationAllowed(env, { accessKey: 'the-real-key-123456' });
  assert.equal(policy.requiresAccessKey, true);
});

test('describeAccessPolicy never leaks the key and reports the shape', () => {
  const described = describeAccessPolicy({ NODE_ENV: 'production', APP_ACCESS_KEY: 'super-secret-key' });
  assert.equal(described.private, true);
  assert.equal(described.registration.requiresAccessKey, true);
  assert.equal(JSON.stringify(described).includes('super-secret-key'), false);
});

test('emailVerificationRequired reflects the env flag', () => {
  assert.equal(emailVerificationRequired({ REQUIRE_EMAIL_VERIFICATION: 'true' }), true);
  assert.equal(emailVerificationRequired({}), false);
});

// --- 2. HTTP integration ---------------------------------------------------

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-gate-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, codeRunner: async () => ({ status: 'completed' }) });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async close() {
      queue.stop();
      await new Promise((resolve) => app.server.close(resolve));
      db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function request(base, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    method: options.method,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('HTTP: a gated deployment refuses registration without the access key', async () => {
  const fx = await fixture();
  try {
    await withEnv({ APP_ACCESS_KEY: 'correct-access-key-123', ALLOW_PUBLIC_REGISTRATION: undefined, REQUIRE_EMAIL_VERIFICATION: undefined }, async () => {
      const policy = await request(fx.base, '/auth/policy');
      assert.equal(policy.status, 200);
      assert.equal(policy.body.registration.requiresAccessKey, true);
      assert.equal(policy.body.private, true);

      const missing = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'outsider@example.test', password: PASSWORD } });
      assert.equal(missing.status, 403, JSON.stringify(missing.body));
      assert.equal(missing.body.error, 'ACCESS_KEY_INVALID');

      const wrong = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'outsider@example.test', password: PASSWORD, accessKey: 'guess' } });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.body.error, 'ACCESS_KEY_INVALID');

      const ok = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'insider@example.test', password: PASSWORD, accessKey: 'correct-access-key-123' } });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.ok(ok.body.session?.token, 'the key-holder must receive a live session');
    });
  } finally {
    await fx.close();
  }
});

test('HTTP: open registration can be explicitly disabled', async () => {
  const fx = await fixture();
  try {
    await withEnv({ APP_ACCESS_KEY: undefined, ALLOW_PUBLIC_REGISTRATION: 'false' }, async () => {
      const denied = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'anyone@example.test', password: PASSWORD } });
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      assert.equal(denied.body.error, 'REGISTRATION_DISABLED');
    });
  } finally {
    await fx.close();
  }
});

test('HTTP: email verification withholds the session and blocks login until verified', async () => {
  const fx = await fixture();
  try {
    await withEnv({ APP_ACCESS_KEY: undefined, ALLOW_PUBLIC_REGISTRATION: 'true', REQUIRE_EMAIL_VERIFICATION: 'true' }, async () => {
      const registered = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'verify-me@example.test', password: PASSWORD } });
      assert.equal(registered.status, 201, JSON.stringify(registered.body));
      assert.equal(registered.body.verificationRequired, true);
      assert.equal(registered.body.session, null, 'no session may be issued before verification');

      const login = await request(fx.base, '/auth/login', { method: 'POST', body: { email: 'verify-me@example.test', password: PASSWORD } });
      assert.equal(login.status, 403, JSON.stringify(login.body));
      assert.equal(login.body.error, 'EMAIL_VERIFICATION_REQUIRED');
    });
  } finally {
    await fx.close();
  }
});

test('HTTP: /auth/session only returns an identity for a live token', async () => {
  const fx = await fixture();
  try {
    await withEnv({ APP_ACCESS_KEY: undefined, ALLOW_PUBLIC_REGISTRATION: 'true', REQUIRE_EMAIL_VERIFICATION: undefined }, async () => {
      const registered = await request(fx.base, '/auth/register', { method: 'POST', body: { email: 'live@example.test', password: PASSWORD } });
      const token = registered.body.session.token;

      const live = await request(fx.base, '/auth/session', { token });
      assert.equal(live.status, 200);
      assert.equal(live.body.user.email, 'live@example.test');

      const anonymous = await request(fx.base, '/auth/session', {});
      assert.equal(anonymous.status, 401);

      await request(fx.base, '/auth/logout', { method: 'POST', token });
      const revoked = await request(fx.base, '/auth/session', { token });
      assert.equal(revoked.status, 401, 'a revoked token must no longer resolve');
    });
  } finally {
    await fx.close();
  }
});
