// Real Stripe billing adapter. Talks to the Stripe REST API over HTTPS with a
// bounded timeout and never logs or returns the secret key. All methods fail
// closed with explicit error codes so an unconfigured deployment can never
// present a fake checkout as working.

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function encodeForm(params, prefix = '', out = []) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item && typeof item === 'object') encodeForm(item, `${name}[${index}]`, out);
        else out.push([`${name}[${index}]`, String(item)]);
      });
    } else if (typeof value === 'object') {
      encodeForm(value, name, out);
    } else {
      out.push([name, String(value)]);
    }
  }
  return out;
}

async function stripeRequest(secretKey, path, { method = 'POST', params, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('BILLING_PROVIDER_TIMEOUT')), timeoutMs);
  try {
    const body = params ? new URLSearchParams(encodeForm(params)).toString() : undefined;
    let response;
    try {
      response = await fetch(`${STRIPE_API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          'stripe-version': '2024-06-20',
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      // Never surface a transport error (it may echo the request URL / headers).
      if (controller.signal.aborted) throw new Error('BILLING_PROVIDER_TIMEOUT');
      throw new Error('BILLING_PROVIDER_UNREACHABLE');
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    if (!response.ok) {
      const raw = data?.error?.code || data?.error?.type || `HTTP_${response.status}`;
      const code = String(raw).split(String(secretKey)).join('[REDACTED]');
      throw new Error(`BILLING_PROVIDER_ERROR:${code}`);
    }
    return data ?? {};
  } finally {
    clearTimeout(timer);
  }
}

export function createStripeAdapter(env = process.env) {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('BILLING_PROVIDER_NOT_CONFIGURED');
  const timeoutMs = Number(env.BILLING_TIMEOUT_MS || 20000);

  return {
    id: 'stripe',
    async createCustomer({ email, tenantId, name }) {
      const data = await stripeRequest(secretKey, '/customers', {
        params: { email, name: name || tenantId, metadata: { tenant_id: tenantId } },
        timeoutMs,
      });
      if (!data.id) throw new Error('BILLING_PROVIDER_INVALID_RESPONSE');
      return { customerId: data.id };
    },
    async createCheckoutSession({ customerId, priceId, tenantId, planId, successUrl, cancelUrl }) {
      const data = await stripeRequest(secretKey, '/checkout/sessions', {
        params: {
          mode: 'subscription',
          customer: customerId,
          client_reference_id: tenantId,
          success_url: successUrl,
          cancel_url: cancelUrl,
          line_items: [{ price: priceId, quantity: 1 }],
          metadata: { tenant_id: tenantId, plan_id: planId },
          subscription_data: { metadata: { tenant_id: tenantId, plan_id: planId } },
          allow_promotion_codes: true,
        },
        timeoutMs,
      });
      if (!data.id || !data.url) throw new Error('BILLING_PROVIDER_INVALID_RESPONSE');
      return { sessionId: data.id, url: data.url };
    },
    async createPortalSession({ customerId, returnUrl }) {
      const data = await stripeRequest(secretKey, '/billing_portal/sessions', {
        params: { customer: customerId, return_url: returnUrl },
        timeoutMs,
      });
      if (!data.url) throw new Error('BILLING_PROVIDER_INVALID_RESPONSE');
      return { url: data.url };
    },
    async cancelSubscription({ subscriptionId }) {
      const data = await stripeRequest(secretKey, `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: 'DELETE',
        timeoutMs,
      });
      return { canceled: data.status === 'canceled' || Boolean(data.cancel_at_period_end), status: data.status ?? null, id: data.id ?? subscriptionId };
    },
  };
}

export function billingProviderStatus(env = process.env) {
  const provider = env.BILLING_PROVIDER || null;
  if (!provider) return { configured: false, provider: null, reason: 'billing_provider_not_configured' };
  if (!env.BILLING_WEBHOOK_SECRET) return { configured: false, provider, reason: 'billing_webhook_secret_not_configured' };
  if (provider === 'stripe') {
    if (!env.STRIPE_SECRET_KEY) return { configured: false, provider, reason: 'stripe_secret_key_not_configured' };
    return { configured: true, provider, reason: null };
  }
  return { configured: false, provider, reason: `billing_provider_unsupported:${provider}` };
}
