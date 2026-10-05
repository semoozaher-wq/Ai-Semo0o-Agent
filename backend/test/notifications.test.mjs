import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';
import { createEmailProvider, enqueueEmail, listOutbox, processOutbox } from '../notifications/outbox.mjs';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-notify-'));
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

test('enqueueEmail persists a queued row and an audit entry, and validates input', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'owner@notify.test', password: 'correct horse battery staple', tenantName: 'Notify' });
    const result = enqueueEmail(fx.db, { tenantId: user.tenant_id, to: 'Recipient@Example.com', template: 'email_verification', body: 'token-123' });
    assert.equal(result.status, 'queued');
    const row = fx.db.get('SELECT * FROM email_outbox WHERE id=?', result.outboxId);
    assert.equal(row.to_email, 'recipient@example.com');
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 0);
    const audit = fx.db.get("SELECT * FROM audit_logs WHERE action='email.queued' AND resource_id=?", result.outboxId);
    assert.ok(audit, 'expected an audit log entry for the queued email');

    assert.throws(() => enqueueEmail(fx.db, { to: 'x@y.z', template: 'nope' }), /INVALID_EMAIL_TEMPLATE/);
    assert.throws(() => enqueueEmail(fx.db, { to: 'not-an-email', template: 'invitation' }), /INVALID_EMAIL_RECIPIENT/);
  } finally { await fx.close(); }
});

test('processOutbox is a fail-closed no-op when no provider is configured', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'noprovider@notify.test', password: 'correct horse battery staple', tenantName: 'NoProvider' });
    enqueueEmail(fx.db, { tenantId: user.tenant_id, to: 'a@b.co', template: 'invitation', body: 'tok' });
    const result = await processOutbox(fx.db, { env: {} });
    assert.equal(result.providerConfigured, false);
    assert.equal(result.processed, 0);
    assert.equal(result.queued, 1);
    // The queued row must be preserved, never silently dropped.
    assert.equal(fx.db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE status='queued'").n, 1);
    assert.equal(createEmailProvider({}), null);
    assert.equal(createEmailProvider({ EMAIL_PROVIDER: 'webhook' }), null, 'webhook without URL must fail closed');
    assert.equal(createEmailProvider({ EMAIL_PROVIDER: 'unknown', EMAIL_WEBHOOK_URL: 'http://x' }), null, 'unknown provider must fail closed');
  } finally { await fx.close(); }
});

test('processOutbox delivers queued mail through the webhook provider with a valid signature', async () => {
  const fx = await fixture();
  const received = [];
  const secret = 'whsec_test_123';
  const sink = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      received.push({ signature: req.headers['x-semo0o-signature'], body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'provider-msg-1' }));
    });
  });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${sink.address().port}/send`;
  try {
    const user = createUser(fx.db, { email: 'deliver@notify.test', password: 'correct horse battery staple', tenantName: 'Deliver' });
    enqueueEmail(fx.db, { tenantId: user.tenant_id, to: 'dest@example.com', template: 'password_reset', body: 'reset-token' });
    const env = { EMAIL_PROVIDER: 'webhook', EMAIL_WEBHOOK_URL: url, EMAIL_WEBHOOK_SECRET: secret };
    const result = await processOutbox(fx.db, { env });
    assert.equal(result.providerConfigured, true);
    assert.equal(result.sent, 1);
    assert.equal(result.failed, 0);
    assert.equal(received.length, 1);
    const expected = createHmac('sha256', secret).update(received[0].body).digest('hex');
    assert.equal(received[0].signature, expected, 'HMAC signature must cover the exact payload');
    const row = fx.db.get('SELECT * FROM email_outbox LIMIT 1');
    assert.equal(row.status, 'sent');
    assert.equal(row.provider_id, 'provider-msg-1');
    assert.ok(row.sent_at);
  } finally {
    await new Promise((resolve) => sink.close(resolve));
    await fx.close();
  }
});

test('account lifecycle routes enqueue real outbox rows (register, reset, invite)', async () => {
  const fx = await fixture();
  try {
    const registered = await fx.request('/auth/register', { method: 'POST', body: { email: 'signup@notify.test', password: 'correct horse battery staple', tenantName: 'Signup' } });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.delivery, 'queued');
    assert.ok(registered.body.outboxId);
    const verification = fx.db.get("SELECT * FROM email_outbox WHERE template='email_verification'");
    assert.equal(verification.to_email, 'signup@notify.test');
    assert.equal(verification.status, 'queued');

    const reset = await fx.request('/auth/request-password-reset', { method: 'POST', body: { email: 'signup@notify.test' } });
    assert.equal(reset.status, 202);
    assert.equal(reset.body.delivery, 'queued');
    assert.ok(fx.db.get("SELECT * FROM email_outbox WHERE template='password_reset'"));
    // Unknown emails must not leak existence and must not enqueue anything.
    const unknown = await fx.request('/auth/request-password-reset', { method: 'POST', body: { email: 'ghost@notify.test' } });
    assert.equal(unknown.status, 202);
    assert.equal(unknown.body.delivery, 'NOT_VERIFIED_EMAIL_DELIVERY');
    assert.equal(fx.db.get("SELECT COUNT(*) AS n FROM email_outbox WHERE to_email='ghost@notify.test'").n, 0);

    const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'signup@notify.test', password: 'correct horse battery staple' } });
    const token = login.body.session.token;
    const invite = await fx.request('/org/invitations', { method: 'POST', token, body: { email: 'teammate@notify.test', role: 'member' } });
    assert.equal(invite.status, 201);
    assert.equal(invite.body.delivery, 'queued');
    assert.ok(fx.db.get("SELECT * FROM email_outbox WHERE template='invitation'"));
  } finally { await fx.close(); }
});

test('notifications API is admin-only and tenant-isolated', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'api-notify@notify.test', password: 'correct horse battery staple', tenantName: 'ApiNotify' });
    const other = createUser(fx.db, { email: 'api-other@notify.test', password: 'correct horse battery staple', tenantName: 'ApiOther' });
    enqueueEmail(fx.db, { tenantId: owner.tenant_id, to: 'owner-inbox@notify.test', template: 'invitation', body: 'tok' });

    const ownerLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'api-notify@notify.test', password: 'correct horse battery staple' } });
    const ownerToken = ownerLogin.body.session.token;
    const otherLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'api-other@notify.test', password: 'correct horse battery staple' } });
    const otherToken = otherLogin.body.session.token;

    const list = await fx.request('/notifications/outbox', { token: ownerToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.providerConfigured, false);
    assert.equal(list.body.emails.length, 1);
    assert.equal(list.body.emails[0].to, 'owner-inbox@notify.test');

    // A different tenant sees none of this tenant's mail.
    const otherList = await fx.request('/notifications/outbox', { token: otherToken });
    assert.equal(otherList.body.emails.length, 0);

    // A member (non-admin) is forbidden.
    fx.db.run("UPDATE users SET role='member' WHERE id=?", owner.id);
    const forbidden = await fx.request('/notifications/outbox', { token: ownerToken });
    assert.equal(forbidden.status, 403);

    // Process route reports the fail-closed state without a provider.
    fx.db.run("UPDATE users SET role='owner' WHERE id=?", owner.id);
    const processed = await fx.request('/notifications/outbox/process', { method: 'POST', token: ownerToken });
    assert.equal(processed.status, 200);
    assert.equal(processed.body.providerConfigured, false);
    assert.equal(processed.body.sent, 0);
  } finally { await fx.close(); }
});

test('listOutbox filters by status and is bounded', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'list@notify.test', password: 'correct horse battery staple', tenantName: 'List' });
    enqueueEmail(fx.db, { tenantId: user.tenant_id, to: 'one@notify.test', template: 'invitation', body: 'a' });
    const second = enqueueEmail(fx.db, { tenantId: user.tenant_id, to: 'two@notify.test', template: 'invitation', body: 'b' });
    fx.db.run("UPDATE email_outbox SET status='sent' WHERE id=?", second.outboxId);
    assert.equal(listOutbox(fx.db, user.tenant_id).length, 2);
    const queued = listOutbox(fx.db, user.tenant_id, { status: 'queued' });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].to, 'one@notify.test');
  } finally { await fx.close(); }
});
