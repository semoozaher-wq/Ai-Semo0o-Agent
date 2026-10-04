import { createHmac, timingSafeEqual } from 'node:crypto';
import { id, now } from '../db/client.mjs';

export const PLANS = Object.freeze({
  free: Object.freeze({ id: 'free', monthlyRuns: 1000, monthlyTokens: 100000 }),
  pro: Object.freeze({ id: 'pro', monthlyRuns: 10000, monthlyTokens: 2000000 }),
  team: Object.freeze({ id: 'team', monthlyRuns: 100000, monthlyTokens: 20000000 }),
});

export function planById(planId) {
  const plan = PLANS[String(planId)];
  if (!plan) throw new Error('BILLING_PLAN_NOT_FOUND');
  return plan;
}

export function billingStatus(db, tenantId) {
  const subscription = db.get('SELECT * FROM subscriptions WHERE tenant_id=? AND status IN (\'trialing\',\'active\',\'past_due\') ORDER BY updated_at DESC LIMIT 1', tenantId);
  const plan = planById(subscription?.plan_id ?? 'free');
  return { plan, subscription: subscription ?? null };
}

export function verifyWebhookSignature(rawBody, signature, secret) {
  if (!secret || typeof signature !== 'string') throw new Error('BILLING_WEBHOOK_SECRET_REQUIRED');
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const actual = signature.replace(/^sha256=/, '');
  if (!/^[a-f0-9]{64}$/i.test(actual)) throw new Error('BILLING_WEBHOOK_SIGNATURE_INVALID');
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))) throw new Error('BILLING_WEBHOOK_SIGNATURE_INVALID');
  return true;
}

export function applyWebhookEvent(db, { provider, eventId, eventType, payload }) {
  if (!provider || !eventId || !eventType || !payload) throw new Error('BILLING_WEBHOOK_INVALID');
  return db.transaction(() => {
    const existing = db.get('SELECT id FROM billing_events WHERE event_id=?', eventId);
    if (existing) return { applied: false, duplicate: true };
    db.run('INSERT INTO billing_events(id,provider,event_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('billing_event'), provider, eventId, eventType, JSON.stringify(payload), now());
    return { applied: true, duplicate: false };
  });
}

export function requireBillingProvider(env = process.env) {
  if (!env.BILLING_PROVIDER || !env.BILLING_WEBHOOK_SECRET) throw new Error('BILLING_PROVIDER_NOT_CONFIGURED');
  throw new Error('BILLING_PROVIDER_ADAPTER_NOT_IMPLEMENTED');
}
