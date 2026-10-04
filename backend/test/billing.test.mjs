import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { Database } from '../db/client.mjs';
import { createUser } from '../auth/security.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { PLANS, applyWebhookEvent, billingStatus, planById, requireBillingProvider, verifyWebhookSignature } from '../billing/service.mjs';

test('billing plans fail closed for unknown plans and default to free', async () => {
  assert.equal(planById('pro'), PLANS.pro);
  assert.throws(() => planById('enterprise'), /BILLING_PLAN_NOT_FOUND/);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-billing-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try { assert.equal(billingStatus(db, 'missing').plan.id, 'free'); } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('billing webhook signatures are verified and events are idempotent', async () => {
  const secret = 'billing-test-secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyWebhookSignature(body, signature, secret), true);
  const invalidSignature = (signature[0] === '0' ? '1' : '0') + signature.slice(1);
  assert.throws(() => verifyWebhookSignature(body, invalidSignature, secret), /BILLING_WEBHOOK_SIGNATURE_INVALID/);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-billing-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    assert.deepEqual(applyWebhookEvent(db, { provider: 'test', eventId: 'evt_1', eventType: 'customer.subscription.updated', payload: { tenantId: 't1' } }), { applied: true, duplicate: false });
    assert.deepEqual(applyWebhookEvent(db, { provider: 'test', eventId: 'evt_1', eventType: 'customer.subscription.updated', payload: { tenantId: 't1' } }), { applied: false, duplicate: true });
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('billing provider integration never reports fake checkout success', () => {
  assert.throws(() => requireBillingProvider({}), /BILLING_PROVIDER_NOT_CONFIGURED/);
});

test('billing webhook applies subscription state and syncs quota limits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-billing-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const user = createUser(db, { email: 'billing@example.test', password: 'correct horse battery staple', tenantName: 'Billing' });
    const tenantId = user.tenant_id;
    const created = { id: 'evt_sub_1', type: 'customer.subscription.created', data: { object: { id: 'sub_123', customer: 'cus_123', status: 'active', current_period_end: 1900000000, metadata: { tenant_id: tenantId, plan_id: 'pro' } } } };
    assert.deepEqual(applyWebhookEvent(db, { provider: 'stripe', eventId: created.id, eventType: created.type, payload: created }), { applied: true, duplicate: false });
    const status = billingStatus(db, tenantId);
    assert.equal(status.plan.id, 'pro');
    assert.equal(status.subscription.status, 'active');
    assert.equal(db.get('SELECT monthly_tokens FROM usage_quotas WHERE tenant_id=?', tenantId).monthly_tokens, PLANS.pro.monthlyTokens);
    // A duplicate event must not double-apply.
    assert.deepEqual(applyWebhookEvent(db, { provider: 'stripe', eventId: created.id, eventType: created.type, payload: created }), { applied: false, duplicate: true });
    // Cancellation downgrades the effective plan + quota back to free.
    const canceled = { id: 'evt_sub_2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_123', customer: 'cus_123', status: 'canceled', metadata: { tenant_id: tenantId, plan_id: 'pro' } } } };
    applyWebhookEvent(db, { provider: 'stripe', eventId: canceled.id, eventType: canceled.type, payload: canceled });
    assert.equal(billingStatus(db, tenantId).plan.id, 'free');
    assert.equal(db.get('SELECT monthly_tokens FROM usage_quotas WHERE tenant_id=?', tenantId).monthly_tokens, PLANS.free.monthlyTokens);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('billing webhook route verifies the signature over the raw body', async () => {
  const secret = 'whsec_test_secret';
  const previousSecret = process.env.BILLING_WEBHOOK_SECRET;
  const previousProvider = process.env.BILLING_PROVIDER;
  process.env.BILLING_WEBHOOK_SECRET = secret;
  process.env.BILLING_PROVIDER = 'stripe';
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-billing-http-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const user = createUser(db, { email: 'wh@example.test', password: 'correct horse battery staple', tenantName: 'WH' });
    const event = { id: 'evt_http_1', type: 'customer.subscription.created', data: { object: { id: 'sub_http', customer: 'cus_http', status: 'active', metadata: { tenant_id: user.tenant_id, plan_id: 'team' } } } };
    const raw = JSON.stringify(event);
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    const ok = await fetch(`${base}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: raw });
    assert.equal(ok.status, 200);
    assert.equal(billingStatus(db, user.tenant_id).plan.id, 'team');
    const forged = await fetch(`${base}/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 'f'.repeat(64) }, body: raw });
    assert.equal(forged.status, 400);
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.BILLING_WEBHOOK_SECRET; else process.env.BILLING_WEBHOOK_SECRET = previousSecret;
    if (previousProvider === undefined) delete process.env.BILLING_PROVIDER; else process.env.BILLING_PROVIDER = previousProvider;
  }
});
