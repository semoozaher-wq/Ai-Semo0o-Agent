import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createSession, createUser } from '../auth/security.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { createImageProvider, createVisionProvider, createCalendarProvider, createEmailSendProvider, connectorStatus } from '../tools/connectors.mjs';
import { createEmbeddingProvider, embeddingStatus, localEmbedding } from '../memory/embeddings.mjs';
import { buildAuthorizeUrl, createGitHubClient, githubStatus, parseRepoSlug } from '../github/service.mjs';
import { billingProviderStatus, createStripeAdapter } from '../billing/stripe.mjs';
import { requireBillingProvider } from '../billing/service.mjs';
import { createErrorTracker, errorTrackerStatus } from '../observability/error-tracking.mjs';
import { browserBinaryAvailable, resolveCdpEndpoint } from '../browser/launcher.mjs';

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

/* ------------------------------ Connectors -------------------------------- */

test('connectors fail closed when nothing is configured', () => {
  const env = {};
  assert.equal(createImageProvider(env), null);
  assert.equal(createVisionProvider(env), null);
  assert.equal(createCalendarProvider(env), null);
  assert.equal(createEmailSendProvider(env), null);
  assert.deepEqual(connectorStatus(env), { image: false, vision: false, calendar: false, email: false });
});

test('image.generate performs a real OpenAI-compatible call and returns bytes', async () => {
  const env = { IMAGE_PROVIDER: 'openai', IMAGE_API_KEY: 'sk-test-key', IMAGE_API_BASE: 'https://api.example.test/v1' };
  const provider = createImageProvider(env);
  assert.ok(provider);
  const seen = {};
  const result = await withFetch(async (url, init) => {
    seen.url = url; seen.auth = init.headers.authorization; seen.body = JSON.parse(init.body);
    return jsonResponse({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64'), revised_prompt: 'revised' }] });
  }, () => provider.generate({ prompt: 'a cat', size: '512x512' }));
  assert.equal(seen.url, 'https://api.example.test/v1/images/generations');
  assert.equal(seen.auth, 'Bearer sk-test-key');
  assert.equal(seen.body.prompt, 'a cat');
  assert.equal(result.provider, 'openai');
  assert.equal(Buffer.from(result.base64, 'base64').toString(), 'PNGDATA');
});

test('image.generate surfaces provider HTTP errors without leaking the key', async () => {
  const env = { IMAGE_PROVIDER: 'openai', IMAGE_API_KEY: 'sk-secret-value', IMAGE_API_BASE: 'https://api.example.test/v1' };
  const provider = createImageProvider(env);
  await assert.rejects(
    () => withFetch(async () => jsonResponse({ error: { message: 'bad request' } }, { status: 400 }), () => provider.generate({ prompt: 'x' })),
    (error) => { assert.match(error.message, /CONNECTOR_HTTP_400/); assert.doesNotMatch(error.message, /sk-secret-value/); return true; },
  );
});

test('image.analyze uses the configured vision provider', async () => {
  const env = { VISION_PROVIDER: 'openai', VISION_API_KEY: 'sk-vision', VISION_API_BASE: 'https://api.example.test/v1' };
  const provider = createVisionProvider(env);
  assert.ok(provider);
  const result = await withFetch(async () => jsonResponse({ choices: [{ message: { content: 'a red square' } }], usage: { total_tokens: 5 } }), () => provider.analyze({ base64: 'AAAA', mimeType: 'image/png', prompt: 'what is this' }));
  assert.equal(result.text, 'a red square');
  assert.equal(result.usage.total_tokens, 5);
});

test('calendar.schedule posts to the configured webhook', async () => {
  const env = { CALENDAR_PROVIDER: 'webhook', CALENDAR_WEBHOOK_URL: 'https://cal.example.test/hook' };
  const provider = createCalendarProvider(env);
  assert.ok(provider);
  const seen = {};
  const result = await withFetch(async (url, init) => { seen.url = url; seen.body = JSON.parse(init.body); return jsonResponse({ eventId: 'evt_1', status: 'accepted' }); }, () => provider.createEvent({ title: 'Standup', when: '2025-01-01T09:00:00Z', durationMinutes: 30 }));
  assert.equal(seen.url, 'https://cal.example.test/hook');
  assert.equal(seen.body.title, 'Standup');
  assert.equal(result.eventId, 'evt_1');
});

test('email.send posts to the configured webhook and returns a message id', async () => {
  const env = { EMAIL_PROVIDER: 'webhook', EMAIL_WEBHOOK_URL: 'https://mail.example.test/send' };
  const provider = createEmailSendProvider(env);
  assert.ok(provider);
  const result = await withFetch(async () => jsonResponse({ id: 'msg_42' }), () => provider.send({ to: 'user@example.test', subject: 'Hi', body: 'Hello' }));
  assert.equal(result.messageId, 'msg_42');
});

test('registry reports connector tools live only when a provider is configured', async () => {
  const registry = createLiveToolRegistry();
  const before = registry.status().tools.find((tool) => tool.id === 'email.send');
  assert.equal(before.state, 'unwired');
  const previous = process.env.EMAIL_PROVIDER;
  const previousUrl = process.env.EMAIL_WEBHOOK_URL;
  process.env.EMAIL_PROVIDER = 'webhook';
  process.env.EMAIL_WEBHOOK_URL = 'https://mail.example.test/send';
  try {
    const registry2 = createLiveToolRegistry();
    const after = registry2.status().tools.find((tool) => tool.id === 'email.send');
    assert.equal(after.state, 'live');
    const output = await withFetch(async () => jsonResponse({ id: 'msg_live' }), () => registry2.run('email.send', { to: 'a@b.test', subject: 's', body: 'b' }));
    assert.equal(output.output.delivered, true);
    assert.equal(output.output.messageId, 'msg_live');
  } finally {
    if (previous === undefined) delete process.env.EMAIL_PROVIDER; else process.env.EMAIL_PROVIDER = previous;
    if (previousUrl === undefined) delete process.env.EMAIL_WEBHOOK_URL; else process.env.EMAIL_WEBHOOK_URL = previousUrl;
  }
});

/* ------------------------------ Embeddings -------------------------------- */

test('embedding provider falls back to local and reports status honestly', () => {
  assert.equal(createEmbeddingProvider({}), null);
  const status = embeddingStatus({});
  assert.equal(status.configured, false);
  assert.equal(status.provider, 'local');
  assert.equal(localEmbedding('hello world').length, 64);
});

test('managed embedding provider calls the OpenAI-compatible endpoint', async () => {
  const env = { EMBEDDING_PROVIDER: 'openai', EMBEDDING_API_KEY: 'sk-emb', EMBEDDING_API_URL: 'https://api.example.test/v1/embeddings' };
  const provider = createEmbeddingProvider(env);
  assert.ok(provider);
  const vector = await withFetch(async () => jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), () => provider.embed('text'));
  assert.deepEqual(vector, [0.1, 0.2, 0.3]);
  assert.equal(provider.dimensions, 3);
});

/* -------------------------------- GitHub ---------------------------------- */

test('github helpers parse slugs, build authorize urls and validate config', () => {
  assert.deepEqual(parseRepoSlug('octocat/hello-world'), { owner: 'octocat', repo: 'hello-world' });
  assert.throws(() => parseRepoSlug('not-a-slug'), /GITHUB_REPO_INVALID/);
  const url = buildAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://app.test/cb', state: 'xyz' });
  assert.match(url, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.match(url, /client_id=cid/);
  assert.match(url, /state=xyz/);
  assert.equal(githubStatus({}).configured, false);
  assert.equal(githubStatus({ GITHUB_TOKEN: 'ghp_x' }).configured, true);
});

test('github client creates issues and pull requests over the REST API', async () => {
  const client = createGitHubClient({ token: 'ghp_test' });
  const seen = [];
  const result = await withFetch(async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.authorization });
    if (url.endsWith('/issues')) return jsonResponse({ number: 7, html_url: 'https://github.com/o/r/issues/7', title: 'Bug' }, { status: 201 });
    return jsonResponse({ number: 9, html_url: 'https://github.com/o/r/pull/9', state: 'open' }, { status: 201 });
  }, async () => {
    const issue = await client.createIssue({ owner: 'o', repo: 'r', title: 'Bug', body: 'desc', labels: ['bug'] });
    const pr = await client.createPullRequest({ owner: 'o', repo: 'r', title: 'Fix', head: 'feature', base: 'main' });
    return { issue, pr };
  });
  assert.equal(result.issue.number, 7);
  assert.equal(result.pr.number, 9);
  assert.equal(seen[0].auth, 'Bearer ghp_test');
  assert.match(seen[0].url, /api\.github\.com\/repos\/o\/r\/issues$/);
});

/* -------------------------------- Billing --------------------------------- */

test('billing provider resolves a real Stripe adapter and reports status', () => {
  const status = billingProviderStatus({ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: 'whsec', STRIPE_SECRET_KEY: 'sk_live' });
  assert.equal(status.configured, true);
  assert.equal(billingProviderStatus({ BILLING_PROVIDER: 'stripe' }).configured, false);
  const adapter = requireBillingProvider({ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: 'whsec', STRIPE_SECRET_KEY: 'sk_live' });
  assert.equal(adapter.id, 'stripe');
  assert.throws(() => requireBillingProvider({ BILLING_PROVIDER: 'stripe', BILLING_WEBHOOK_SECRET: 'whsec' }), /BILLING_PROVIDER_NOT_CONFIGURED/);
  assert.throws(() => requireBillingProvider({ BILLING_PROVIDER: 'paypal', BILLING_WEBHOOK_SECRET: 'x' }), /BILLING_PROVIDER_UNSUPPORTED/);
});

test('stripe adapter creates customers and checkout sessions', async () => {
  const adapter = createStripeAdapter({ STRIPE_SECRET_KEY: 'sk_test_123' });
  const seen = [];
  const result = await withFetch(async (url, init) => {
    seen.push({ url, body: init.body });
    if (url.endsWith('/customers')) return jsonResponse({ id: 'cus_1' });
    if (url.endsWith('/checkout/sessions')) return jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    return jsonResponse({ url: 'https://portal.stripe.test/p_1' });
  }, async () => {
    const customer = await adapter.createCustomer({ email: 'a@b.test', tenantId: 't1' });
    const session = await adapter.createCheckoutSession({ customerId: customer.customerId, priceId: 'price_1', tenantId: 't1', planId: 'pro', successUrl: 'https://app.test/ok', cancelUrl: 'https://app.test/no' });
    return { customer, session };
  });
  assert.equal(result.customer.customerId, 'cus_1');
  assert.equal(result.session.url, 'https://checkout.stripe.test/cs_1');
  assert.match(seen[0].body, /metadata%5Btenant_id%5D=t1/);
});

/* ------------------------------- Sentry ----------------------------------- */

test('error tracking parses a Sentry DSN and stays off when unconfigured', () => {
  assert.equal(createErrorTracker({}), null);
  assert.equal(errorTrackerStatus({}).configured, false);
  const tracker = createErrorTracker({ SENTRY_DSN: 'https://pubkey@o1.ingest.sentry.io/42' });
  assert.equal(tracker.provider, 'sentry');
  assert.equal(errorTrackerStatus({ SENTRY_DSN: 'https://pubkey@o1.ingest.sentry.io/42' }).configured, true);
  assert.throws(() => createErrorTracker({ SENTRY_DSN: 'not-a-url' }), /SENTRY_DSN_INVALID/);
});

test('error tracker posts an event and never throws on failure', async () => {
  const tracker = createErrorTracker({ SENTRY_DSN: 'https://pubkey@o1.ingest.sentry.io/42' });
  const eventId = await withFetch(async () => jsonResponse({ id: 'evt' }), () => tracker.captureException(new Error('boom'), { transaction: 'GET /x' }));
  assert.ok(eventId);
  const failed = await withFetch(async () => { throw new Error('network down'); }, () => tracker.captureException(new Error('boom')));
  assert.equal(failed, null);
});

/* ------------------------------- Browser ---------------------------------- */

test('browser launcher fails closed without a binary or CDP endpoint', async () => {
  // No browser is installed in CI; the launcher must report that honestly.
  assert.equal(typeof browserBinaryAvailable(), 'boolean');
  await assert.rejects(() => resolveCdpEndpoint({}), /TOOL_CONNECTOR_NOT_CONFIGURED:browser\.run/);
  const external = await resolveCdpEndpoint({ BROWSER_CDP_URL: 'ws://127.0.0.1:9222/devtools/browser/x' });
  assert.equal(external.webSocketUrl, 'ws://127.0.0.1:9222/devtools/browser/x');
  assert.equal(external.launcher, null);
});

/* --------------------------- End-to-end routes ---------------------------- */

test('integrations status route reports honest connector states', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-integrations-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const user = createUser(db, { email: 'int@example.test', password: 'correct horse battery staple', tenantName: 'Int' });
    const token = createSession(db, user.id).token;
    const response = await fetch(`${base}/integrations/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.tools.unwired.includes('image.generate'));
    assert.equal(body.billing.configured, false);
    assert.equal(body.github.configured, false);
    assert.equal(body.embeddings.provider, 'local');
    assert.equal(body.errorTracking.configured, false);
    assert.equal(body.browser.cdpConfigured, false);
    // GitHub status route is honest too.
    const gh = await fetch(`${base}/github/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(gh.status, 200);
    assert.equal((await gh.json()).connection, null);
    // Starting OAuth without configuration fails closed.
    const start = await fetch(`${base}/github/oauth/start`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    assert.equal(start.status, 503);
    assert.equal((await start.json()).error, 'GITHUB_OAUTH_NOT_CONFIGURED');
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
