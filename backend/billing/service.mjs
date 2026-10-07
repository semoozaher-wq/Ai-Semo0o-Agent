import { createHmac, timingSafeEqual } from 'node:crypto';
import { id, now } from '../db/client.mjs';
import { createStripeAdapter } from './stripe.mjs';

export const PLANS = Object.freeze({
  free: Object.freeze({ id: 'free', monthlyRuns: 1000, monthlyTokens: 100000 }),
  pro: Object.freeze({ id: 'pro', monthlyRuns: 10000, monthlyTokens: 2000000 }),
  team: Object.freeze({ id: 'team', monthlyRuns: 100000, monthlyTokens: 20000000 }),
});

const SUBSCRIPTION_STATUSES = new Set(['trialing', 'active', 'past_due', 'canceled', 'incomplete', 'unpaid']);

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

// Extract the subscription-relevant fields from a provider webhook payload. Supports
// a Stripe-style `{ data: { object } }` envelope as well as a flattened object, and
// both unix-second and ISO timestamps for the period end.
function extractSubscription(payload) {
  const object = payload?.data?.object ?? payload?.object ?? payload ?? {};
  const metadata = object.metadata ?? payload?.metadata ?? {};
  const rawPeriodEnd = object.current_period_end ?? payload?.current_period_end;
  let currentPeriodEnd = null;
  if (rawPeriodEnd !== undefined && rawPeriodEnd !== null && rawPeriodEnd !== '') {
    const numeric = Number(rawPeriodEnd);
    currentPeriodEnd = Number.isFinite(numeric) && numeric > 1_000_000_000 ? new Date(numeric * 1000).toISOString() : String(rawPeriodEnd);
  }
  return {
    tenantId: metadata.tenant_id ?? metadata.tenantId ?? payload?.tenantId ?? null,
    planId: metadata.plan_id ?? metadata.planId ?? object.plan ?? null,
    providerSubscriptionId: object.subscription ?? object.id ?? null,
    providerCustomerId: object.customer ?? null,
    status: object.status ?? null,
    currentPeriodEnd,
  };
}

function syncQuotaToPlan(db, tenantId, plan) {
  db.run('INSERT INTO usage_quotas(tenant_id,monthly_tokens,monthly_runs,updated_at) VALUES(?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET monthly_tokens=excluded.monthly_tokens,monthly_runs=excluded.monthly_runs,updated_at=excluded.updated_at', tenantId, plan.monthlyTokens, plan.monthlyRuns, now());
}

/**
 * Apply a provider event to the local subscription + quota state. Returns the
 * affected subscription summary, or null when the event cannot be mapped to a
 * known tenant (the raw event is still recorded for audit + replay).
 */
function applySubscriptionTransition(db, provider, eventType, payload) {
  const info = extractSubscription(payload);
  const existingBySub = info.providerSubscriptionId ? db.get('SELECT * FROM subscriptions WHERE provider_subscription_id=?', info.providerSubscriptionId) : null;
  let tenantId = info.tenantId;
  if (!tenantId && existingBySub) tenantId = existingBySub.tenant_id;
  if (!tenantId && info.providerCustomerId) {
    const byCustomer = db.get('SELECT tenant_id FROM subscriptions WHERE provider=? AND provider_customer_id=? ORDER BY updated_at DESC LIMIT 1', provider, info.providerCustomerId);
    if (byCustomer) tenantId = byCustomer.tenant_id;
  }
  if (!tenantId) return null;
  if (!db.get('SELECT id FROM tenants WHERE id=?', tenantId)) return null;

  const isCancel = eventType.endsWith('.deleted') || eventType.endsWith('.canceled');
  const isPastDue = eventType === 'invoice.payment_failed';
  const isActive = eventType === 'invoice.paid' || eventType === 'invoice.payment_succeeded';
  let status;
  if (isCancel) status = 'canceled';
  else if (isPastDue) status = 'past_due';
  else if (isActive) status = 'active';
  else if (info.status && SUBSCRIPTION_STATUSES.has(info.status)) status = info.status;
  else status = 'active';

  const planId = info.planId && PLANS[info.planId] ? info.planId : (existingBySub?.plan_id ?? 'free');
  const subscriptionId = existingBySub?.id ?? id('subscription');
  const timestamp = now();
  const currentPeriodEnd = info.currentPeriodEnd ?? existingBySub?.current_period_end ?? null;
  const providerSubscriptionId = info.providerSubscriptionId ?? existingBySub?.provider_subscription_id ?? null;
  const providerCustomerId = info.providerCustomerId ?? existingBySub?.provider_customer_id ?? null;

  if (existingBySub) {
    db.run('UPDATE subscriptions SET plan_id=?,status=?,current_period_end=?,provider_customer_id=?,updated_at=? WHERE id=?', planId, status, currentPeriodEnd, providerCustomerId, timestamp, subscriptionId);
  } else {
    db.run('INSERT INTO subscriptions(id,tenant_id,provider,provider_customer_id,provider_subscription_id,plan_id,status,current_period_end,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', subscriptionId, tenantId, provider, providerCustomerId, providerSubscriptionId, planId, status, currentPeriodEnd, timestamp, timestamp);
  }

  // Quota limits always reflect the currently effective plan (fall back to free when
  // the subscription is not active/trialing so a lapsed tenant cannot keep pro quota).
  const effectivePlan = ['active', 'trialing'].includes(status) ? planById(planId) : planById('free');
  syncQuotaToPlan(db, tenantId, effectivePlan);
  return { tenantId, planId, status, currentPeriodEnd };
}

export function applyWebhookEvent(db, { provider, eventId, eventType, payload }) {
  if (!provider || !eventId || !eventType || !payload) throw new Error('BILLING_WEBHOOK_INVALID');
  return db.transaction(() => {
    const existing = db.get('SELECT id FROM billing_events WHERE event_id=?', eventId);
    if (existing) return { applied: false, duplicate: true };
    db.run('INSERT INTO billing_events(id,provider,event_id,event_type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('billing_event'), provider, eventId, eventType, JSON.stringify(payload), now());
    applySubscriptionTransition(db, provider, eventType, payload);
    return { applied: true, duplicate: false };
  });
}

export function requireBillingProvider(env = process.env) {
  if (!env.BILLING_PROVIDER || !env.BILLING_WEBHOOK_SECRET) throw new Error('BILLING_PROVIDER_NOT_CONFIGURED');
  const provider = String(env.BILLING_PROVIDER).toLowerCase();
  if (provider === 'stripe') return createStripeAdapter(env);
  throw new Error(`BILLING_PROVIDER_UNSUPPORTED:${provider}`);
}
