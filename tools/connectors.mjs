/**
 * Real, environment-configurable connector adapters.
 *
 * These adapters back the tool ids that previously existed only as hard-coded
 * fail-closed stubs: `image.generate`, `image.analyze`, `calendar.schedule` and
 * `email.send`. Every adapter returns `null` when its provider is not configured,
 * so the tool registry keeps the honest `TOOL_CONNECTOR_NOT_CONFIGURED:<id>`
 * posture and never fabricates a success. When a provider IS configured the
 * adapter performs a real network call with a bounded timeout and a bounded
 * response size.
 *
 * Design rules (shared with the rest of the backend):
 *   - fail closed: no provider -> null -> the tool throws, it never fakes output;
 *   - bounded I/O: every request has a timeout and a maximum response size;
 *   - no secret leakage: errors never echo the API key; callers redact anyway;
 *   - operator-configured endpoints only (never user-supplied URLs) for the
 *     provider gateways, so the adapters cannot be turned into an SSRF vector.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MB decoded image cap
const MAX_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB response cap

function timeoutMs(env, key, fallback = DEFAULT_TIMEOUT_MS) {
  const value = Number(env[key]);
  return Number.isFinite(value) && value >= 1000 && value <= 600_000 ? value : fallback;
}

async function fetchWithTimeout(url, init = {}, { timeoutMs: ms = DEFAULT_TIMEOUT_MS, maxBytes = MAX_TEXT_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('CONNECTOR_TIMEOUT')), ms);
  try {
    let response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch {
      // A transport failure must never leak the request URL: webhook endpoints
      // (e.g. Slack incoming hooks) carry their credential in the URL path, and
      // some runtimes echo the URL into the error/cause. Preserve our own
      // timeout code, otherwise report a stable, URL-free code.
      if (controller.signal.aborted) throw new Error('CONNECTOR_TIMEOUT');
      throw new Error('CONNECTOR_UNREACHABLE');
    }
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('CONNECTOR_RESPONSE_TOO_LARGE');
    return { response, text };
  } finally {
    clearTimeout(timer);
  }
}

// Scrub any configured credential value from text that leaves the adapter. The
// design rule is "errors never echo the API key": even if a provider echoes the
// key back in its error body, the adapter must not surface it.
function scrubSecrets(text, config = {}) {
  let out = String(text);
  for (const value of [config.apiKey, config.token, config.secret]) {
    if (value && String(value).length >= 6) out = out.split(String(value)).join('[REDACTED]');
  }
  return out;
}

async function readJson(response, text, config = {}) {
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const detail = payload?.error?.message ?? payload?.error ?? payload?.message ?? payload?.raw ?? '';
    const error = new Error(`CONNECTOR_HTTP_${response.status}${detail ? `:${scrubSecrets(String(detail).slice(0, 200), config)}` : ''}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/*  Image generation                                                          */
/* -------------------------------------------------------------------------- */

function imageOpenAiConfig(env) {
  const apiKey = env.IMAGE_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    id: 'openai',
    apiKey,
    baseUrl: (env.IMAGE_API_BASE || env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.IMAGE_MODEL || 'gpt-image-1',
  };
}

function imageGeminiConfig(env) {
  const apiKey = env.IMAGE_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  return { id: 'gemini', apiKey, model: env.IMAGE_MODEL || 'gemini-2.5-flash-image' };
}

function imageHttpConfig(env) {
  if (!env.IMAGE_HTTP_URL) return null;
  return { id: 'http', url: env.IMAGE_HTTP_URL, secret: env.IMAGE_HTTP_SECRET || '' };
}

/**
 * Resolve an image-generation provider from the environment.
 * @returns {{id:string, generate:Function}|null}
 */
export function createImageProvider(env = process.env) {
  const explicit = String(env.IMAGE_PROVIDER || '').toLowerCase();
  const candidates = [
    ['openai', imageOpenAiConfig],
    ['gemini', imageGeminiConfig],
    ['http', imageHttpConfig],
  ];
  const order = explicit ? candidates.filter(([name]) => name === explicit) : candidates;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'openai') return { id: 'openai', model: config.model, generate: (input) => openaiGenerateImage(config, input, env) };
    if (name === 'gemini') return { id: 'gemini', model: config.model, generate: (input) => geminiGenerateImage(config, input, env) };
    if (name === 'http') return { id: 'http', model: 'http', generate: (input) => httpGenerateImage(config, input, env) };
  }
  return null;
}

function normalizeSize(size) {
  const value = String(size || '1024x1024');
  return /^\d{2,5}x\d{2,5}$/.test(value) ? value : '1024x1024';
}

async function openaiGenerateImage(config, { prompt, size }, env) {
  const { response, text } = await fetchWithTimeout(
    `${config.baseUrl}/images/generations`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, prompt, size: normalizeSize(size), n: 1 }),
    },
    { timeoutMs: timeoutMs(env, 'IMAGE_TIMEOUT_MS', 120_000) },
  );
  const payload = await readJson(response, text, config);
  const item = payload?.data?.[0] ?? {};
  if (item.b64_json) return { provider: config.id, model: config.model, mimeType: 'image/png', base64: item.b64_json, revisedPrompt: item.revised_prompt ?? null };
  if (item.url) {
    const image = await fetchWithTimeout(item.url, {}, { timeoutMs: timeoutMs(env, 'IMAGE_TIMEOUT_MS', 120_000), maxBytes: MAX_IMAGE_BYTES });
    if (!image.response.ok) throw new Error(`CONNECTOR_IMAGE_FETCH_${image.response.status}`);
    return { provider: config.id, model: config.model, mimeType: image.response.headers.get('content-type') || 'image/png', base64: Buffer.from(image.text, 'binary').toString('base64'), revisedPrompt: item.revised_prompt ?? null };
  }
  throw new Error('CONNECTOR_IMAGE_EMPTY_RESPONSE');
}

async function geminiGenerateImage(config, { prompt }, env) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const { response, text } = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    },
    { timeoutMs: timeoutMs(env, 'IMAGE_TIMEOUT_MS', 120_000) },
  );
  const payload = await readJson(response, text, config);
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find((part) => part?.inlineData?.data);
  if (!inline) throw new Error('CONNECTOR_IMAGE_EMPTY_RESPONSE');
  return { provider: config.id, model: config.model, mimeType: inline.inlineData.mimeType || 'image/png', base64: inline.inlineData.data, revisedPrompt: null };
}

async function httpGenerateImage(config, { prompt, size }, env) {
  const body = JSON.stringify({ prompt, size: normalizeSize(size) });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'IMAGE_TIMEOUT_MS', 120_000) });
  const payload = await readJson(response, text, config);
  const base64 = payload?.image?.base64 ?? payload?.b64_json ?? payload?.data?.[0]?.b64_json;
  if (!base64) throw new Error('CONNECTOR_IMAGE_EMPTY_RESPONSE');
  return { provider: config.id, model: payload?.model ?? 'http', mimeType: payload?.image?.mimeType ?? 'image/png', base64, revisedPrompt: null };
}

/* -------------------------------------------------------------------------- */
/*  Vision / image analysis                                                   */
/* -------------------------------------------------------------------------- */

function visionOpenAiConfig(env) {
  const apiKey = env.VISION_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    id: 'openai',
    apiKey,
    baseUrl: (env.VISION_API_BASE || env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.VISION_MODEL || env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
  };
}

function visionGeminiConfig(env) {
  const apiKey = env.VISION_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  return { id: 'gemini', apiKey, model: env.VISION_MODEL || 'gemini-2.5-flash' };
}

/**
 * Resolve a vision (image understanding) provider from the environment.
 * @returns {{id:string, analyze:Function}|null}
 */
export function createVisionProvider(env = process.env) {
  const explicit = String(env.VISION_PROVIDER || '').toLowerCase();
  const builders = [['openai', visionOpenAiConfig], ['gemini', visionGeminiConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'openai') return { id: 'openai', model: config.model, analyze: (input) => openaiAnalyzeImage(config, input, env) };
    if (name === 'gemini') return { id: 'gemini', model: config.model, analyze: (input) => geminiAnalyzeImage(config, input, env) };
  }
  return null;
}

async function openaiAnalyzeImage(config, { base64, mimeType, prompt }, env) {
  const question = prompt || 'Describe this image faithfully. Extract any visible text. Do not invent details.';
  const { response, text } = await fetchWithTimeout(
    `${config.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          ],
        }],
      }),
    },
    { timeoutMs: timeoutMs(env, 'VISION_TIMEOUT_MS', 90_000) },
  );
  const payload = await readJson(response, text, config);
  return { provider: config.id, model: config.model, text: payload?.choices?.[0]?.message?.content ?? '', usage: payload?.usage ?? null };
}

async function geminiAnalyzeImage(config, { base64, mimeType, prompt }, env) {
  const question = prompt || 'Describe this image faithfully. Extract any visible text. Do not invent details.';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const { response, text } = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: question }, { inlineData: { mimeType, data: base64 } }] }] }),
    },
    { timeoutMs: timeoutMs(env, 'VISION_TIMEOUT_MS', 90_000) },
  );
  const payload = await readJson(response, text, config);
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const answer = parts.filter((part) => typeof part?.text === 'string').map((part) => part.text).join('');
  return { provider: config.id, model: config.model, text: answer, usage: payload?.usageMetadata ?? null };
}

/* -------------------------------------------------------------------------- */
/*  Calendar                                                                  */
/* -------------------------------------------------------------------------- */

function calendarGoogleConfig(env) {
  const token = env.CALENDAR_ACCESS_TOKEN || env.GOOGLE_CALENDAR_ACCESS_TOKEN;
  if (!token) return null;
  return { id: 'google', token, calendarId: env.CALENDAR_ID || 'primary', timeZone: env.CALENDAR_TIMEZONE || 'UTC' };
}

function calendarWebhookConfig(env) {
  if (!env.CALENDAR_WEBHOOK_URL) return null;
  return { id: 'webhook', url: env.CALENDAR_WEBHOOK_URL, secret: env.CALENDAR_WEBHOOK_SECRET || '' };
}

/**
 * Resolve a calendar provider from the environment.
 * @returns {{id:string, createEvent:Function}|null}
 */
export function createCalendarProvider(env = process.env) {
  const explicit = String(env.CALENDAR_PROVIDER || '').toLowerCase();
  const builders = [['google', calendarGoogleConfig], ['webhook', calendarWebhookConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'google') return { id: 'google', createEvent: (input) => googleCreateEvent(config, input, env) };
    if (name === 'webhook') return { id: 'webhook', createEvent: (input) => webhookCreateEvent(config, input, env) };
  }
  return null;
}

function toIso(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name}_INVALID_DATETIME`);
  return date.toISOString();
}

async function googleCreateEvent(config, { title, when, durationMinutes = 30, description = '' }, env) {
  const start = toIso(when, 'CALENDAR_WHEN');
  const end = new Date(new Date(start).getTime() + Math.max(5, Math.min(Number(durationMinutes) || 30, 1440)) * 60_000).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events`;
  const { response, text } = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: title, description, start: { dateTime: start, timeZone: config.timeZone }, end: { dateTime: end, timeZone: config.timeZone } }),
    },
    { timeoutMs: timeoutMs(env, 'CALENDAR_TIMEOUT_MS', 30_000) },
  );
  const payload = await readJson(response, text, config);
  return { provider: config.id, eventId: payload.id ?? null, htmlLink: payload.htmlLink ?? null, start, end, status: payload.status ?? null };
}

async function webhookCreateEvent(config, input, env) {
  const start = toIso(input.when, 'CALENDAR_WHEN');
  const body = JSON.stringify({ title: input.title, when: start, durationMinutes: Number(input.durationMinutes) || 30, description: input.description || '' });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'CALENDAR_TIMEOUT_MS', 30_000) });
  const payload = await readJson(response, text, config);
  return { provider: config.id, eventId: payload?.id ?? payload?.eventId ?? null, htmlLink: payload?.htmlLink ?? null, start, status: payload?.status ?? 'accepted' };
}

/* -------------------------------------------------------------------------- */
/*  Email send (tool-facing, direct delivery)                                 */
/* -------------------------------------------------------------------------- */

function emailResendConfig(env) {
  if (!env.EMAIL_API_KEY || String(env.EMAIL_PROVIDER || '').toLowerCase() !== 'resend') return null;
  return { id: 'resend', apiKey: env.EMAIL_API_KEY, from: env.EMAIL_FROM || 'onboarding@resend.dev' };
}

function emailSendgridConfig(env) {
  if (!env.EMAIL_API_KEY || String(env.EMAIL_PROVIDER || '').toLowerCase() !== 'sendgrid') return null;
  return { id: 'sendgrid', apiKey: env.EMAIL_API_KEY, from: env.EMAIL_FROM || 'no-reply@example.com' };
}

function emailWebhookConfig(env) {
  if (!env.EMAIL_WEBHOOK_URL) return null;
  return { id: 'webhook', url: env.EMAIL_WEBHOOK_URL, secret: env.EMAIL_WEBHOOK_SECRET || '' };
}

/**
 * Resolve a direct email-delivery provider from the environment. Distinct from
 * the outbox adapter because a tool call must deliver synchronously and report
 * the provider's message id.
 * @returns {{id:string, send:Function}|null}
 */
export function createEmailSendProvider(env = process.env) {
  const explicit = String(env.EMAIL_PROVIDER || '').toLowerCase();
  const builders = [['resend', emailResendConfig], ['sendgrid', emailSendgridConfig], ['webhook', emailWebhookConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'resend') return { id: 'resend', send: (input) => resendSend(config, input, env) };
    if (name === 'sendgrid') return { id: 'sendgrid', send: (input) => sendgridSend(config, input, env) };
    if (name === 'webhook') return { id: 'webhook', send: (input) => webhookSend(config, input, env) };
  }
  return null;
}

function normalizeRecipient(value) {
  const email = String(value ?? '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('INVALID_EMAIL_RECIPIENT');
  return email;
}

async function resendSend(config, { to, subject, body }, env) {
  const { response, text } = await fetchWithTimeout(
    'https://api.resend.com/emails',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.from, to: [normalizeRecipient(to)], subject, text: body }),
    },
    { timeoutMs: timeoutMs(env, 'EMAIL_TIMEOUT_MS', 30_000) },
  );
  const payload = await readJson(response, text, config);
  return { provider: config.id, messageId: payload.id ?? null };
}

async function sendgridSend(config, { to, subject, body }, env) {
  const { response, text } = await fetchWithTimeout(
    'https://api.sendgrid.com/v3/mail/send',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email: normalizeRecipient(to) }] }], from: { email: config.from }, subject, content: [{ type: 'text/plain', value: body }] }),
    },
    { timeoutMs: timeoutMs(env, 'EMAIL_TIMEOUT_MS', 30_000) },
  );
  if (!response.ok) await readJson(response, text, config); // throws with the provider detail
  return { provider: config.id, messageId: response.headers.get('x-message-id') ?? null };
}

async function webhookSend(config, { to, subject, body }, env) {
  const payload = JSON.stringify({ to: normalizeRecipient(to), subject, body });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text } = await fetchWithTimeout(config.url, { method: 'POST', headers, body: payload }, { timeoutMs: timeoutMs(env, 'EMAIL_TIMEOUT_MS', 30_000) });
  const result = await readJson(response, text, config);
  return { provider: config.id, messageId: result?.id ?? result?.messageId ?? null };
}

/** Report which connector families are configured (for honest status output). */
export function connectorStatus(env = process.env) {
  return {
    image: Boolean(createImageProvider(env)),
    vision: Boolean(createVisionProvider(env)),
    calendar: Boolean(createCalendarProvider(env)),
    email: Boolean(createEmailSendProvider(env)),
  };
}
