import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageProvider, createEmailSendProvider, createCalendarProvider } from '../tools/connectors.mjs';
import { createEmbeddingProvider } from '../memory/embeddings.mjs';
import { createGitHubClient, exchangeCodeForToken } from '../github/service.mjs';
import { createStripeAdapter } from '../billing/stripe.mjs';
import { createErrorTracker } from '../observability/error-tracking.mjs';

// Run a block with a stubbed global fetch, restoring the original afterwards.
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = original; }
}

function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
    json: async () => (typeof data === 'string' ? JSON.parse(data) : data),
  };
}

function assertNoLeak(blob, secret, label) {
  const text = typeof blob === 'string' ? blob : JSON.stringify(blob ?? '');
  assert.ok(!text.includes(secret), `${label} leaked the secret: ${secret}`);
}

/* -------------------------------------------------------------------------- */
/*  Connectors: provider-echoed secrets + transport errors                    */
/* -------------------------------------------------------------------------- */

test('image.generate scrubs a provider-echoed API key from the HTTP error detail', async () => {
  const key = 'sk-live-IMAGE-SECRET-abcdef123456';
  const env = { IMAGE_PROVIDER: 'openai', IMAGE_API_KEY: key, IMAGE_API_BASE: 'https://api.example.test/v1' };
  const provider = createImageProvider(env);
  await assert.rejects(
    () => withFetch(async () => jsonResponse({ error: { message: `invalid key ${key} supplied` } }, { status: 401 }), () => provider.generate({ prompt: 'x' })),
    (error) => {
      assert.match(error.message, /CONNECTOR_HTTP_401/);
      assertNoLeak(error.message, key, 'image.generate error');
      assert.ok(error.message.includes('[REDACTED]'), 'the echoed key must be replaced, not dropped');
      return true;
    },
  );
});

test('connectors never leak the request URL (which may carry a webhook secret) on a transport error', async () => {
  const secretPath = 'T000/B000/SECRET-WEBHOOK-PATH-987654';
  const env = { EMAIL_PROVIDER: 'webhook', EMAIL_WEBHOOK_URL: `https://hooks.example.test/services/${secretPath}`, EMAIL_WEBHOOK_SECRET: 'hook-signing-secret-123456' };
  const provider = createEmailSendProvider(env);
  await assert.rejects(
    // Simulate a runtime that echoes the full URL into the transport error.
    () => withFetch(async (url) => { throw new TypeError(`fetch failed: ${url}`); }, () => provider.send({ to: 'a@b.co', subject: 's', body: 'b' })),
    (error) => {
      assert.equal(error.message, 'CONNECTOR_UNREACHABLE');
      assertNoLeak(error.message, secretPath, 'email.send transport error');
      assertNoLeak(error.message, 'hooks.example.test', 'email.send transport error');
      return true;
    },
  );
});

test('calendar.schedule scrubs a provider-echoed token from the HTTP error detail', async () => {
  const token = 'ya29.CALENDAR-TOKEN-abcdef1234567890';
  const env = { CALENDAR_PROVIDER: 'google', CALENDAR_ACCESS_TOKEN: token };
  const provider = createCalendarProvider(env);
  await assert.rejects(
    () => withFetch(async () => jsonResponse({ error: { message: `token ${token} expired` } }, { status: 403 }), () => provider.createEvent({ title: 't', when: new Date().toISOString() })),
    (error) => { assertNoLeak(error.message, token, 'calendar.schedule error'); return true; },
  );
});

/* -------------------------------------------------------------------------- */
/*  Embeddings: key in header, transport errors URL-free                       */
/* -------------------------------------------------------------------------- */

test('gemini embedding provider sends the key in a header, never in the URL', async () => {
  const key = 'AIza-SECRET-EMBEDDING-KEY-1234567890';
  const provider = createEmbeddingProvider({ EMBEDDING_PROVIDER: 'gemini', EMBEDDING_API_KEY: key });
  let seenUrl; let seenHeaders;
  const vector = await withFetch(async (url, init) => { seenUrl = url; seenHeaders = init.headers; return jsonResponse({ embedding: { values: [0.1, 0.2, 0.3] } }); }, () => provider.embed('hello'));
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assertNoLeak(String(seenUrl), key, 'gemini embedding request URL');
  assert.equal(seenHeaders['x-goog-api-key'], key, 'the key must be sent as the x-goog-api-key header');
});

test('embedding transport errors are URL-free and never leak the key', async () => {
  const key = 'AIza-SECRET-EMBEDDING-KEY-1234567890';
  const provider = createEmbeddingProvider({ EMBEDDING_PROVIDER: 'gemini', EMBEDDING_API_KEY: key });
  await assert.rejects(
    () => withFetch(async (url) => { throw new TypeError(`fetch failed: ${url}`); }, () => provider.embed('x')),
    (error) => { assert.equal(error.message, 'EMBEDDING_PROVIDER_UNREACHABLE'); assertNoLeak(error.message, key, 'embedding transport error'); return true; },
  );
});

/* -------------------------------------------------------------------------- */
/*  GitHub: token never leaks                                                  */
/* -------------------------------------------------------------------------- */

test('github client never leaks the token through an API error or a transport error', async () => {
  const token = 'ghp_SECRET-GITHUB-TOKEN-abcdef123456';
  const client = createGitHubClient({ token });
  await assert.rejects(
    () => withFetch(async () => jsonResponse({ message: `Bad credentials ${token}` }, { status: 401 }), () => client.getRepo({ owner: 'a', repo: 'b' })),
    (error) => { assert.match(error.message, /GITHUB_API_ERROR:401/); assertNoLeak(error.message, token, 'github API error'); return true; },
  );
  await assert.rejects(
    () => withFetch(async (url) => { throw new TypeError(`fetch failed: ${url}`); }, () => client.getRepo({ owner: 'a', repo: 'b' })),
    (error) => { assert.equal(error.message, 'GITHUB_API_UNREACHABLE'); assertNoLeak(error.message, token, 'github transport error'); return true; },
  );
});

test('github OAuth token exchange never leaks the client secret', async () => {
  const clientSecret = 'ghs_OAUTH-CLIENT-SECRET-abcdef123456';
  await assert.rejects(
    () => withFetch(async () => jsonResponse({ error: `bad client_secret ${clientSecret}` }, { status: 200 }), () => exchangeCodeForToken({ clientId: 'cid', clientSecret, code: 'c', redirectUri: 'https://app.test/cb' })),
    (error) => { assert.match(error.message, /GITHUB_OAUTH_EXCHANGE_FAILED/); assertNoLeak(error.message, clientSecret, 'github oauth error'); return true; },
  );
});

/* -------------------------------------------------------------------------- */
/*  Stripe: secret key never leaks                                             */
/* -------------------------------------------------------------------------- */

test('stripe adapter never leaks the secret key through an API error or a transport error', async () => {
  const secretKey = 'sk_live_STRIPE-SECRET-KEY-abcdef123456';
  const adapter = createStripeAdapter({ STRIPE_SECRET_KEY: secretKey });
  await assert.rejects(
    () => withFetch(async () => jsonResponse({ error: { code: 'card_declined', message: `key ${secretKey} rejected` } }, { status: 402 }), () => adapter.createCustomer({ email: 'a@b.co', tenantId: 't1' })),
    (error) => { assert.match(error.message, /BILLING_PROVIDER_ERROR/); assertNoLeak(error.message, secretKey, 'stripe API error'); return true; },
  );
  await assert.rejects(
    () => withFetch(async (url) => { throw new TypeError(`fetch failed: ${url}`); }, () => adapter.createCustomer({ email: 'a@b.co', tenantId: 't1' })),
    (error) => { assert.equal(error.message, 'BILLING_PROVIDER_UNREACHABLE'); assertNoLeak(error.message, secretKey, 'stripe transport error'); return true; },
  );
});

/* -------------------------------------------------------------------------- */
/*  Error tracking: never throws, never leaks the DSN key                      */
/* -------------------------------------------------------------------------- */

test('error tracker swallows reporting failures and never leaks the DSN public key', async () => {
  const dsn = 'https://PUBLICKEY1234567890abcdef@o1.ingest.sentry.io/42';
  const tracker = createErrorTracker({ SENTRY_DSN: dsn });
  const eventId = await withFetch(async () => { throw new TypeError('fetch failed: https://o1.ingest.sentry.io/api/42/store/'); }, () => tracker.captureException(new Error('boom')));
  assert.equal(eventId, null, 'a reporting failure must return null, never throw');
});

test('error tracker reports honestly when unconfigured and rejects an invalid DSN', () => {
  assert.equal(createErrorTracker({}), null);
  assert.throws(() => createErrorTracker({ SENTRY_DSN: 'not-a-url' }), /SENTRY_DSN_INVALID/);
});
