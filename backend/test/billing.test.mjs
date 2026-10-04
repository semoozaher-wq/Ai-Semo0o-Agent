import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import { Database } from '../db/client.mjs';
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
