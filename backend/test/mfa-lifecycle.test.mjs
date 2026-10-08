import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, hash } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';

// ---------------------------------------------------------------------------
// A real, end-to-end MFA lifecycle over the HTTP API. This is the proof that the
// second-factor feature is *wired* (routes exist) AND *works* (a real client can
// enroll, confirm, and then authenticate with TOTP and with a recovery code),
// not merely that the handlers are present. The TOTP codes are computed here
// from the secret the server returns, exactly like an authenticator app would.
// ---------------------------------------------------------------------------

// RFC 4648 base32 decode (no padding), matching backend/auth/lifecycle.mjs.
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of String(input).replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('INVALID_MFA_SECRET');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(value).padStart(6, '0');
}

// A live code for "now" (the server accepts a +/-1 step window).
function currentTotp(secret) {
  return totp(secret, Math.floor(Date.now() / 30000));
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-mfa-e2e-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return {
    dir, db, queue, app, base, request,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('MFA lifecycle: enroll -> confirm -> login with TOTP and single-use recovery code', async () => {
  const previousKey = process.env.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEY = '11'.repeat(32);
  const fx = await fixture();
  try {
    const email = 'mfa-e2e@lifecycle.test';
    const password = 'correct horse battery staple';

    // 1. Register: the session token is returned immediately.
    const registered = await fx.request('/auth/register', { method: 'POST', body: { email, password, tenantName: 'MFA E2E' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    assert.ok(token);

    // 2. The profile route reports the honest (not-yet-enabled) MFA state.
    const before = await fx.request('/me', { token });
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(before.body.user.email, email);
    assert.equal(before.body.user.mfaEnabled, false);

    // 3. Start enrollment: the server returns the shared secret + recovery codes.
    const setup = await fx.request('/auth/mfa/setup', { method: 'POST', token, body: {} });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    assert.equal(typeof setup.body.secret, 'string');
    assert.equal(setup.body.secret.length >= 16, true);
    assert.equal(setup.body.enabled, false);
    assert.equal(Array.isArray(setup.body.recoveryCodes), true);
    assert.equal(setup.body.recoveryCodes.length, 10);

    // 4. Confirming with a WRONG code must be rejected (and must not enable MFA).
    const wrong = await fx.request('/auth/mfa/confirm', { method: 'POST', token, body: { code: '000000' } });
    assert.equal(wrong.status, 401, JSON.stringify(wrong.body));
    assert.equal(wrong.body.error, 'MFA_CODE_INVALID');
    assert.equal((await fx.request('/me', { token })).body.user.mfaEnabled, false);

    // 5. Confirming with a real TOTP code derived from the secret enables MFA.
    const confirmed = await fx.request('/auth/mfa/confirm', { method: 'POST', token, body: { code: currentTotp(setup.body.secret) } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.enabled, true);

    // 6. The profile route now reflects the real enabled state.
    const after = await fx.request('/me', { token });
    assert.equal(after.body.user.mfaEnabled, true);

    // 7. Login without a second factor is refused and creates NO session.
    const sessionsBefore = fx.db.get('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?', registered.body.user.id).count;
    const noFactor = await fx.request('/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(noFactor.status, 401, JSON.stringify(noFactor.body));
    assert.equal(noFactor.body.error, 'MFA_REQUIRED');
    assert.equal(fx.db.get('SELECT COUNT(*) AS count FROM sessions WHERE user_id=?', registered.body.user.id).count, sessionsBefore);

    // 8. A wrong second factor is refused.
    const badFactor = await fx.request('/auth/login', { method: 'POST', body: { email, password, mfaCode: '000000' } });
    assert.equal(badFactor.status, 401, JSON.stringify(badFactor.body));
    assert.equal(badFactor.body.error, 'MFA_CODE_INVALID');

    // 9. A valid TOTP code yields a working session.
    const totpLogin = await fx.request('/auth/login', { method: 'POST', body: { email, password, mfaCode: currentTotp(setup.body.secret) } });
    assert.equal(totpLogin.status, 200, JSON.stringify(totpLogin.body));
    assert.ok(totpLogin.body.session.token);
    assert.equal((await fx.request('/me', { token: totpLogin.body.session.token })).status, 200);

    // 10. A recovery code also works, and is single-use.
    const recoveryCode = setup.body.recoveryCodes[0];
    const recoveryLogin = await fx.request('/auth/login', { method: 'POST', body: { email, password, mfaCode: recoveryCode } });
    assert.equal(recoveryLogin.status, 200, JSON.stringify(recoveryLogin.body));
    assert.ok(recoveryLogin.body.session.token);
    const reuse = await fx.request('/auth/login', { method: 'POST', body: { email, password, mfaCode: recoveryCode } });
    assert.equal(reuse.status, 401, JSON.stringify(reuse.body));
    assert.equal(reuse.body.error, 'MFA_CODE_INVALID');

    // 11. The recovery code is stored hashed (never plaintext) and marked used.
    const stored = fx.db.get('SELECT code_hash,used_at FROM recovery_codes WHERE user_id=? AND code_hash=?', registered.body.user.id, hash(recoveryCode));
    assert.ok(stored, 'the used recovery code must exist');
    assert.equal(stored.code_hash === recoveryCode, false);
    assert.equal(stored.used_at !== null, true);
    assert.equal(fx.db.get('SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id=? AND used_at IS NOT NULL', registered.body.user.id).count, 1);
  } finally {
    await fx.close();
    if (previousKey === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = previousKey;
  }
});

test('MFA enrollment fails closed when the secrets master key is absent', async () => {
  const previousKey = process.env.SECRETS_MASTER_KEY;
  delete process.env.SECRETS_MASTER_KEY;
  const fx = await fixture();
  try {
    const registered = await fx.request('/auth/register', { method: 'POST', body: { email: 'no-key@lifecycle.test', password: 'correct horse battery staple', tenantName: 'No Key' } });
    const token = registered.body.session.token;
    // Without a master key the server must refuse to store a TOTP secret at all,
    // rather than silently persisting an unencryptable one.
    const setup = await fx.request('/auth/mfa/setup', { method: 'POST', token, body: {} });
    assert.equal(setup.status, 503, JSON.stringify(setup.body));
    assert.equal(setup.body.error, 'SECRETS_MASTER_KEY_REQUIRED');
    assert.equal(fx.db.get('SELECT mfa_secret FROM users WHERE id=?', registered.body.user.id).mfa_secret, null);
  } finally {
    await fx.close();
    if (previousKey === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = previousKey;
  }
});
