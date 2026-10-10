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
const MAX_MEDIA_BYTES = 64 * 1024 * 1024; // 64 MB decoded audio/video cap
const MAX_AUDIO_UPLOAD_BYTES = 24 * 1024 * 1024; // 24 MB audio upload cap (STT)

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

// Binary sibling of fetchWithTimeout for audio/video payloads: it reads the body
// as an ArrayBuffer (never as text, which would corrupt compressed media) and
// enforces a byte cap so a hostile or misconfigured provider cannot exhaust RAM.
async function fetchBinary(url, init = {}, { timeoutMs: ms = DEFAULT_TIMEOUT_MS, maxBytes = MAX_MEDIA_BYTES, config = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('CONNECTOR_TIMEOUT')), ms);
  try {
    let response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch {
      if (controller.signal.aborted) throw new Error('CONNECTOR_TIMEOUT');
      throw new Error('CONNECTOR_UNREACHABLE');
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) throw new Error('CONNECTOR_RESPONSE_TOO_LARGE');
    const buffer = Buffer.from(arrayBuffer);
    if (!response.ok) {
      const detail = scrubSecrets(buffer.toString('utf8').slice(0, 200), config);
      const error = new Error(`CONNECTOR_HTTP_${response.status}${detail ? `:${detail}` : ''}`);
      error.status = response.status;
      throw error;
    }
    return { response, buffer };
  } finally {
    clearTimeout(timer);
  }
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

/* -------------------------------------------------------------------------- */
/*  Chat / notification connectors (Slack, Teams, Discord)                    */
/* -------------------------------------------------------------------------- */

function slackWebhookConfig(env) {
  if (!env.SLACK_WEBHOOK_URL) return null;
  return { id: 'slack', mode: 'webhook', url: env.SLACK_WEBHOOK_URL };
}
function slackBotConfig(env) {
  if (!env.SLACK_BOT_TOKEN) return null;
  return { id: 'slack', mode: 'bot', token: env.SLACK_BOT_TOKEN, channel: env.SLACK_CHANNEL || '' };
}
/** Resolve a Slack provider (incoming webhook or bot token). @returns {{id:string, post:Function}|null} */
export function createSlackProvider(env = process.env) {
  const explicit = String(env.SLACK_PROVIDER || '').toLowerCase();
  const builders = [['webhook', slackWebhookConfig], ['bot', slackBotConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    return { id: 'slack', post: (input) => (name === 'bot' ? slackBotPost(config, input, env) : slackWebhookPost(config, input, env)) };
  }
  return null;
}

async function slackWebhookPost(config, { text, blocks }, env) {
  const body = JSON.stringify({ text: String(text ?? ''), ...(Array.isArray(blocks) ? { blocks } : {}) });
  const { response, text: raw } = await fetchWithTimeout(config.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, { timeoutMs: timeoutMs(env, 'SLACK_TIMEOUT_MS', 30_000) });
  if (!response.ok) throw new Error(`CONNECTOR_HTTP_${response.status}`);
  return { provider: 'slack', delivered: true, response: raw.slice(0, 200) };
}

async function slackBotPost(config, { text, channel, blocks }, env) {
  const target = String(channel || config.channel || '').trim();
  if (!target) throw new Error('SLACK_CHANNEL_REQUIRED');
  const body = JSON.stringify({ channel: target, text: String(text ?? ''), ...(Array.isArray(blocks) ? { blocks } : {}) });
  const { response, text: raw } = await fetchWithTimeout('https://slack.com/api/chat.postMessage', { method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }, body }, { timeoutMs: timeoutMs(env, 'SLACK_TIMEOUT_MS', 30_000) });
  const payload = await readJson(response, raw, config);
  if (payload.ok === false) throw new Error(`SLACK_API_ERROR:${scrubSecrets(String(payload.error ?? 'unknown'), config)}`);
  return { provider: 'slack', delivered: true, channel: payload.channel ?? target, ts: payload.ts ?? null };
}

function teamsWebhookConfig(env) {
  if (!env.TEAMS_WEBHOOK_URL) return null;
  return { id: 'teams', url: env.TEAMS_WEBHOOK_URL };
}
/** Resolve a Microsoft Teams provider (incoming webhook). @returns {{id:string, post:Function}|null} */
export function createTeamsProvider(env = process.env) {
  const config = teamsWebhookConfig(env);
  if (!config) return null;
  return { id: 'teams', post: (input) => teamsPost(config, input, env) };
}

async function teamsPost(config, { text, title }, env) {
  // Adaptive card so both legacy and modern Teams webhooks render the message.
  const body = JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body: [...(title ? [{ type: 'TextBlock', weight: 'Bolder', text: String(title) }] : []), { type: 'TextBlock', wrap: true, text: String(text ?? '') }] } }] });
  const { response } = await fetchWithTimeout(config.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, { timeoutMs: timeoutMs(env, 'TEAMS_TIMEOUT_MS', 30_000) });
  if (!response.ok) throw new Error(`CONNECTOR_HTTP_${response.status}`);
  return { provider: 'teams', delivered: true };
}

function discordWebhookConfig(env) {
  if (!env.DISCORD_WEBHOOK_URL) return null;
  return { id: 'discord', url: env.DISCORD_WEBHOOK_URL };
}
/** Resolve a Discord provider (channel webhook). @returns {{id:string, post:Function}|null} */
export function createDiscordProvider(env = process.env) {
  const config = discordWebhookConfig(env);
  if (!config) return null;
  return { id: 'discord', post: (input) => discordPost(config, input, env) };
}

async function discordPost(config, { text, username }, env) {
  const content = String(text ?? '').slice(0, 1900); // Discord hard limit is 2000 chars
  const body = JSON.stringify({ content, ...(username ? { username: String(username).slice(0, 80) } : {}) });
  const { response } = await fetchWithTimeout(config.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, { timeoutMs: timeoutMs(env, 'DISCORD_TIMEOUT_MS', 30_000) });
  if (!response.ok) throw new Error(`CONNECTOR_HTTP_${response.status}`);
  return { provider: 'discord', delivered: true };
}

/* -------------------------------------------------------------------------- */
/*  Notion (page creation)                                                    */
/* -------------------------------------------------------------------------- */

function notionConfig(env) {
  const apiKey = env.NOTION_API_KEY;
  if (!apiKey) return null;
  const databaseId = env.NOTION_DATABASE_ID || '';
  const pageId = env.NOTION_PAGE_ID || '';
  if (!databaseId && !pageId) return null;
  return { id: 'notion', apiKey, databaseId, pageId, version: env.NOTION_VERSION || '2022-06-28' };
}
/** Resolve a Notion provider (database or page parent). @returns {{id:string, createPage:Function}|null} */
export function createNotionProvider(env = process.env) {
  const config = notionConfig(env);
  if (!config) return null;
  return { id: 'notion', createPage: (input) => notionCreatePage(config, input, env) };
}

async function notionCreatePage(config, { title, content, databaseId, pageId }, env) {
  const parent = databaseId || config.databaseId
    ? { database_id: databaseId || config.databaseId }
    : { page_id: pageId || config.pageId };
  const properties = parent.database_id
    ? { title: { title: [{ text: { content: String(title ?? 'Untitled').slice(0, 200) } }] } }
    : { title: { title: [{ text: { content: String(title ?? 'Untitled').slice(0, 200) } }] } };
  const children = content
    ? [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(content).slice(0, 1900) } }] } }]
    : [];
  const body = JSON.stringify({ parent, properties, children });
  const { response, text: raw } = await fetchWithTimeout('https://api.notion.com/v1/pages', { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', 'notion-version': config.version }, body }, { timeoutMs: timeoutMs(env, 'NOTION_TIMEOUT_MS', 30_000) });
  const payload = await readJson(response, raw, config);
  return { provider: 'notion', pageId: payload.id ?? null, url: payload.url ?? null };
}

/* -------------------------------------------------------------------------- */
/*  Generic outbound webhook                                                  */
/* -------------------------------------------------------------------------- */

function webhookConfig(env) {
  if (!env.GENERIC_WEBHOOK_URL) return null;
  return { id: 'webhook', url: env.GENERIC_WEBHOOK_URL, secret: env.GENERIC_WEBHOOK_SECRET || '' };
}
/** Resolve a generic outbound webhook provider. @returns {{id:string, post:Function}|null} */
export function createWebhookProvider(env = process.env) {
  const config = webhookConfig(env);
  if (!config) return null;
  return { id: 'webhook', post: (input) => webhookPost(config, input, env) };
}

async function webhookPost(config, { text, event, data }, env) {
  const body = JSON.stringify({ event: event ? String(event).slice(0, 120) : 'agent.notification', text: String(text ?? ''), data: data ?? null, at: new Date().toISOString() });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text: raw } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'WEBHOOK_TIMEOUT_MS', 30_000) });
  const payload = await readJson(response, raw, config);
  return { provider: 'webhook', delivered: true, id: payload?.id ?? null };
}

/* -------------------------------------------------------------------------- */
/*  Speech-to-Text (transcription)                                            */
/* -------------------------------------------------------------------------- */

function sttOpenAiConfig(env) {
  const apiKey = env.STT_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    id: 'openai',
    apiKey,
    baseUrl: (env.STT_API_BASE || env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.STT_MODEL || 'whisper-1',
  };
}

function sttGeminiConfig(env) {
  const apiKey = env.STT_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  return { id: 'gemini', apiKey, model: env.STT_MODEL || 'gemini-2.5-flash' };
}

function sttHttpConfig(env) {
  if (!env.STT_HTTP_URL) return null;
  return { id: 'http', url: env.STT_HTTP_URL, secret: env.STT_HTTP_SECRET || '' };
}

/**
 * Resolve a speech-to-text provider from the environment.
 * @returns {{id:string, model?:string, transcribe:Function}|null}
 */
export function createSpeechToTextProvider(env = process.env) {
  const explicit = String(env.STT_PROVIDER || '').toLowerCase();
  const builders = [['openai', sttOpenAiConfig], ['gemini', sttGeminiConfig], ['http', sttHttpConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'openai') return { id: 'openai', model: config.model, transcribe: (input) => openaiTranscribe(config, input, env) };
    if (name === 'gemini') return { id: 'gemini', model: config.model, transcribe: (input) => geminiTranscribe(config, input, env) };
    if (name === 'http') return { id: 'http', model: 'http', transcribe: (input) => httpTranscribe(config, input, env) };
  }
  return null;
}

function audioFilename(mimeType) {
  const m = String(mimeType || '');
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('mpeg')) return 'audio.mp3';
  if (m.includes('ogg')) return 'audio.ogg';
  if (m.includes('webm')) return 'audio.webm';
  if (m.includes('mp4')) return 'audio.m4a';
  if (m.includes('flac')) return 'audio.flac';
  return 'audio.bin';
}

async function openaiTranscribe(config, { base64, mimeType, language, prompt }, env) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mimeType || 'application/octet-stream' }), audioFilename(mimeType));
  form.append('model', config.model);
  if (language) form.append('language', String(language).slice(0, 16));
  if (prompt) form.append('prompt', String(prompt).slice(0, 1000));
  const { response, text } = await fetchWithTimeout(
    `${config.baseUrl}/audio/transcriptions`,
    { method: 'POST', headers: { authorization: `Bearer ${config.apiKey}` }, body: form },
    { timeoutMs: timeoutMs(env, 'STT_TIMEOUT_MS', 120_000) },
  );
  const payload = await readJson(response, text, config);
  return { provider: config.id, model: config.model, text: payload.text ?? '', language: payload.language ?? null, duration: payload.duration ?? null };
}

async function geminiTranscribe(config, { base64, mimeType, prompt }, env) {
  const instruction = prompt || 'Transcribe this audio verbatim. Return only the transcript text.';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
  const { response, text } = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: instruction }, { inlineData: { mimeType, data: base64 } }] }] }),
    },
    { timeoutMs: timeoutMs(env, 'STT_TIMEOUT_MS', 120_000) },
  );
  const payload = await readJson(response, text, config);
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  return { provider: config.id, model: config.model, text: parts.filter((part) => typeof part?.text === 'string').map((part) => part.text).join(''), language: null, duration: null };
}

async function httpTranscribe(config, { base64, mimeType, language, prompt }, env) {
  const body = JSON.stringify({ audio: base64, mimeType, language: language ?? null, prompt: prompt ?? null });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'STT_TIMEOUT_MS', 120_000) });
  const payload = await readJson(response, text, config);
  return { provider: config.id, model: payload.model ?? 'http', text: payload.text ?? payload.transcript ?? '', language: payload.language ?? null, duration: payload.duration ?? null };
}

/* -------------------------------------------------------------------------- */
/*  Text-to-Speech (synthesis)                                                */
/* -------------------------------------------------------------------------- */

function ttsOpenAiConfig(env) {
  const apiKey = env.TTS_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    id: 'openai',
    apiKey,
    baseUrl: (env.TTS_API_BASE || env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: env.TTS_MODEL || 'gpt-4o-mini-tts',
    voice: env.TTS_VOICE || 'alloy',
  };
}

function ttsElevenLabsConfig(env) {
  const apiKey = env.TTS_API_KEY || env.ELEVENLABS_API_KEY;
  if (!apiKey) return null;
  return { id: 'elevenlabs', apiKey, model: env.TTS_MODEL || 'eleven_multilingual_v2', voice: env.TTS_VOICE || env.ELEVENLABS_VOICE_ID || 'Rachel' };
}

function ttsHttpConfig(env) {
  if (!env.TTS_HTTP_URL) return null;
  return { id: 'http', url: env.TTS_HTTP_URL, secret: env.TTS_HTTP_SECRET || '' };
}

/**
 * Resolve a text-to-speech provider from the environment.
 * @returns {{id:string, model?:string, synthesize:Function}|null}
 */
export function createTextToSpeechProvider(env = process.env) {
  const explicit = String(env.TTS_PROVIDER || '').toLowerCase();
  const builders = [['openai', ttsOpenAiConfig], ['elevenlabs', ttsElevenLabsConfig], ['http', ttsHttpConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'openai') return { id: 'openai', model: config.model, synthesize: (input) => openaiSynthesize(config, input, env) };
    if (name === 'elevenlabs') return { id: 'elevenlabs', model: config.model, synthesize: (input) => elevenLabsSynthesize(config, input, env) };
    if (name === 'http') return { id: 'http', model: 'http', synthesize: (input) => httpSynthesize(config, input, env) };
  }
  return null;
}

const TTS_FORMAT_MIME = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/L16' };

async function openaiSynthesize(config, { text, voice, format }, env) {
  const responseFormat = TTS_FORMAT_MIME[format] ? format : 'mp3';
  const { buffer } = await fetchBinary(
    `${config.baseUrl}/audio/speech`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, voice: voice || config.voice, input: text, response_format: responseFormat }),
    },
    { timeoutMs: timeoutMs(env, 'TTS_TIMEOUT_MS', 120_000), config },
  );
  return { provider: config.id, model: config.model, mimeType: TTS_FORMAT_MIME[responseFormat], base64: buffer.toString('base64') };
}

async function elevenLabsSynthesize(config, { text, voice }, env) {
  const voiceId = voice || config.voice;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;
  const { buffer } = await fetchBinary(
    url,
    {
      method: 'POST',
      headers: { 'xi-api-key': config.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: config.model }),
    },
    { timeoutMs: timeoutMs(env, 'TTS_TIMEOUT_MS', 120_000), config },
  );
  return { provider: config.id, model: config.model, mimeType: 'audio/mpeg', base64: buffer.toString('base64') };
}

async function httpSynthesize(config, { text, voice, format }, env) {
  const body = JSON.stringify({ text, voice: voice ?? null, format: format ?? 'mp3' });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text: raw } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'TTS_TIMEOUT_MS', 120_000) });
  const payload = await readJson(response, raw, config);
  const base64 = payload?.audio?.base64 ?? payload?.base64 ?? payload?.audioBase64;
  if (!base64) throw new Error('CONNECTOR_TTS_EMPTY_RESPONSE');
  return { provider: config.id, model: payload?.model ?? 'http', mimeType: payload?.audio?.mimeType ?? payload?.mimeType ?? 'audio/mpeg', base64 };
}

/* -------------------------------------------------------------------------- */
/*  Video / audio generation (prompt -> bytes)                                */
/* -------------------------------------------------------------------------- */

function videoHttpConfig(env) {
  if (!env.VIDEO_HTTP_URL) return null;
  return { id: 'http', url: env.VIDEO_HTTP_URL, secret: env.VIDEO_HTTP_SECRET || '' };
}
function videoReplicateConfig(env) {
  const apiKey = env.REPLICATE_API_TOKEN;
  if (!apiKey || !env.REPLICATE_VIDEO_VERSION) return null;
  return { id: 'replicate', apiKey, baseUrl: (env.REPLICATE_API_BASE || 'https://api.replicate.com/v1').replace(/\/$/, ''), version: env.REPLICATE_VIDEO_VERSION, model: env.REPLICATE_VIDEO_MODEL || 'replicate/video', maxPolls: Number(env.REPLICATE_MAX_POLLS) || 60, pollIntervalMs: Number(env.REPLICATE_POLL_MS) || 2000 };
}

// Google Veo (Gemini API) — a first-party text-to-video AND image-to-video model.
// Generation is long-running: POST :predictLongRunning returns an operation name
// and we poll the operation until `done`, then download the produced MP4. Veo 3.1
// additionally supports first/last-frame interpolation, up to three reference
// images and video EXTENSION (video-to-video continuation). It does NOT support
// arbitrary editing of existing footage (re-scene / re-light a clip) — that needs
// a dedicated video-to-video model, wired through createVideoEditProvider().
function videoGoogleConfig(env) {
  const apiKey = env.VIDEO_API_KEY || env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  return {
    id: 'google',
    apiKey,
    baseUrl: (env.VIDEO_API_BASE || env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
    model: env.VIDEO_MODEL || 'veo-3.1-generate-001',
    maxPolls: Number(env.VIDEO_MAX_POLLS) || 60,
    pollIntervalMs: Number(env.VIDEO_POLL_MS) || 5000,
    capabilities: { textToVideo: true, imageToVideo: true, videoExtension: true, videoEditing: false },
  };
}

/** Resolve a video-generation provider from the environment. @returns {{id:string, generate:Function}|null} */
export function createVideoProvider(env = process.env) {
  const explicit = String(env.VIDEO_PROVIDER || '').toLowerCase();
  // Google (Veo) is preferred when configured; the pre-existing http/replicate
  // backends are unchanged and still selected when no explicit provider is set
  // and no Google key is present.
  const builders = [['google', videoGoogleConfig], ['replicate', videoReplicateConfig], ['http', videoHttpConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'google') return { id: 'google', model: config.model, capabilities: config.capabilities, generate: (input) => googleGenerateVideo(config, input, env) };
    if (name === 'http') return { id: 'http', model: 'http', capabilities: { textToVideo: true, imageToVideo: true, videoExtension: false, videoEditing: false }, generate: (input) => httpGenerateVideo(config, input, env) };
    if (name === 'replicate') return { id: 'replicate', model: config.model, capabilities: { textToVideo: true, imageToVideo: true, videoExtension: false, videoEditing: false }, generate: (input) => replicateGenerate(config, input, env, 'VIDEO') };
  }
  return null;
}

function audioHttpConfig(env) {
  if (!env.AUDIO_HTTP_URL) return null;
  return { id: 'http', url: env.AUDIO_HTTP_URL, secret: env.AUDIO_HTTP_SECRET || '' };
}
function audioReplicateConfig(env) {
  const apiKey = env.REPLICATE_API_TOKEN;
  if (!apiKey || !env.REPLICATE_AUDIO_VERSION) return null;
  return { id: 'replicate', apiKey, baseUrl: (env.REPLICATE_API_BASE || 'https://api.replicate.com/v1').replace(/\/$/, ''), version: env.REPLICATE_AUDIO_VERSION, model: env.REPLICATE_AUDIO_MODEL || 'replicate/audio', maxPolls: Number(env.REPLICATE_MAX_POLLS) || 60, pollIntervalMs: Number(env.REPLICATE_POLL_MS) || 2000 };
}
/** Resolve an audio/music-generation provider from the environment. @returns {{id:string, generate:Function}|null} */
export function createAudioProvider(env = process.env) {
  const explicit = String(env.AUDIO_PROVIDER || '').toLowerCase();
  const builders = [['http', audioHttpConfig], ['replicate', audioReplicateConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'http') return { id: 'http', model: 'http', generate: (input) => httpGenerateAudio(config, input, env) };
    if (name === 'replicate') return { id: 'replicate', model: config.model, generate: (input) => replicateGenerate(config, input, env, 'AUDIO') };
  }
  return null;
}

// Shared payload resolution: accept either inline base64 or a URL to fetch.
async function resolveMediaPayload(payload, kind, config, env, label) {
  const node = payload?.[kind] ?? payload?.output ?? payload;
  const base64 = (node && typeof node === 'object' ? node.base64 : null) ?? payload?.base64 ?? payload?.b64_json;
  const defaultMime = kind === 'video' ? 'video/mp4' : 'audio/mpeg';
  if (base64) {
    return { provider: config.id, model: (node && typeof node === 'object' ? node.model : null) ?? payload?.model ?? config.id, mimeType: (node && typeof node === 'object' ? node.mimeType : null) ?? payload?.mimeType ?? defaultMime, base64 };
  }
  const url = typeof node === 'string' ? node : node?.url ?? payload?.url ?? payload?.output_url;
  if (url && /^https?:\/\//.test(url)) {
    const { response, buffer } = await fetchBinary(url, {}, { timeoutMs: timeoutMs(env, `${label}_TIMEOUT_MS`, 300_000), maxBytes: MAX_MEDIA_BYTES, config });
    return { provider: config.id, model: payload?.model ?? config.id, mimeType: response.headers.get('content-type') || defaultMime, base64: buffer.toString('base64') };
  }
  throw new Error(`CONNECTOR_${label}_EMPTY_RESPONSE`);
}

async function httpGenerateVideo(config, input, env) {
  const body = JSON.stringify({
    prompt: input.prompt,
    durationSeconds: input.durationSeconds ?? null,
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.video ? { video: input.video } : {}),
  });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'VIDEO_TIMEOUT_MS', 300_000) });
  const payload = await readJson(response, text, config);
  return resolveMediaPayload(payload, 'video', config, env, 'VIDEO');
}

// Normalise a generation input into a Veo `instances[0]` object. Only the fields
// the caller actually supplied are attached, so a plain text-to-video request
// stays a plain text-to-video request.
function veoInstance({ prompt, image, lastFrame, referenceImages, video }) {
  const instance = { prompt };
  const inline = (media, fallback) => (media && media.base64 ? { inlineData: { mimeType: media.mimeType || fallback, data: media.base64 } } : null);
  const first = inline(image, 'image/png');
  if (first) instance.image = first;
  const last = inline(lastFrame, 'image/png');
  if (last) instance.lastFrame = last;
  if (Array.isArray(referenceImages) && referenceImages.length) {
    instance.referenceImages = referenceImages.slice(0, 3)
      .map((ref) => ({ image: inline(ref, 'image/png'), referenceType: ref.referenceType || 'asset' }))
      .filter((ref) => ref.image);
  }
  const vid = inline(video, 'video/mp4');
  if (vid) instance.video = vid;
  return instance;
}

// Veo 3.1 via the Gemini API: start a long-running operation, poll it to
// completion, then download the produced MP4 (signed URL, time-limited).
async function googleGenerateVideo(config, input, env) {
  const parameters = { sampleCount: 1, personGeneration: input.personGeneration || 'allow_adult' };
  if (input.aspectRatio) parameters.aspectRatio = input.aspectRatio;
  if (input.durationSeconds) parameters.durationSeconds = Math.round(input.durationSeconds);
  if (input.resolution) parameters.resolution = input.resolution;
  if (input.negativePrompt) parameters.negativePrompt = input.negativePrompt;
  const body = JSON.stringify({ instances: [veoInstance(input)], parameters });
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey };
  const startUrl = `${config.baseUrl}/models/${encodeURIComponent(config.model)}:predictLongRunning`;
  const start = await fetchWithTimeout(startUrl, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'VIDEO_TIMEOUT_MS', 120_000), config });
  let operation = await readJson(start.response, start.text, config);
  const operationName = operation?.name;
  if (!operationName) throw new Error('VIDEO_OPERATION_MISSING');
  let attempts = 0;
  while (operation?.done !== true && attempts < config.maxPolls) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    const poll = await fetchWithTimeout(`${config.baseUrl}/${operationName}`, { headers: { 'x-goog-api-key': config.apiKey } }, { timeoutMs: 30_000, config });
    operation = await readJson(poll.response, poll.text, config);
    attempts += 1;
  }
  if (operation?.done !== true) throw new Error('VIDEO_OPERATION_TIMEOUT');
  if (operation?.error) throw new Error(`VIDEO_OPERATION_FAILED:${scrubSecrets(String(operation.error.message || operation.error).slice(0, 200), config)}`);
  const sample = operation?.response?.generateVideoResponse?.generatedSamples?.[0]
    ?? operation?.response?.generatedVideos?.[0]
    ?? operation?.response?.videos?.[0];
  const uri = sample?.video?.uri ?? sample?.video?.url ?? sample?.uri;
  if (!uri) throw new Error('VIDEO_OPERATION_EMPTY');
  const { response, buffer } = await fetchBinary(uri, { headers: { 'x-goog-api-key': config.apiKey } }, { timeoutMs: timeoutMs(env, 'VIDEO_DOWNLOAD_TIMEOUT_MS', 300_000), maxBytes: MAX_MEDIA_BYTES, config });
  return { provider: config.id, model: config.model, mimeType: response.headers.get('content-type') || 'video/mp4', base64: buffer.toString('base64') };
}

async function httpGenerateAudio(config, { prompt, durationSeconds }, env) {
  const body = JSON.stringify({ prompt, durationSeconds: durationSeconds ?? null });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'AUDIO_TIMEOUT_MS', 300_000) });
  const payload = await readJson(response, text, config);
  return resolveMediaPayload(payload, 'audio', config, env, 'AUDIO');
}

// Replicate predictions: create then bounded-poll until terminal. `Prefer: wait`
// lets a fast model return `succeeded` on the first call, avoiding a poll loop.
async function runReplicatePrediction(config, { version, input }, env, label) {
  const headers = { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json', prefer: 'wait' };
  const { response, text } = await fetchWithTimeout(`${config.baseUrl}/predictions`, { method: 'POST', headers, body: JSON.stringify({ version, input }) }, { timeoutMs: timeoutMs(env, `${label}_TIMEOUT_MS`, 300_000) });
  let payload = await readJson(response, text, config);
  let attempts = 0;
  while (payload?.status && !['succeeded', 'failed', 'canceled'].includes(payload.status) && attempts < config.maxPolls) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    const poll = await fetchWithTimeout(`${config.baseUrl}/predictions/${encodeURIComponent(payload.id)}`, { headers: { authorization: `Bearer ${config.apiKey}` } }, { timeoutMs: 30_000 });
    payload = await readJson(poll.response, poll.text, config);
    attempts += 1;
  }
  if (payload?.status && payload.status !== 'succeeded') throw new Error(`REPLICATE_${String(payload.status).toUpperCase()}${payload.error ? `:${scrubSecrets(String(payload.error).slice(0, 200), config)}` : ''}`);
  return payload;
}

async function replicateGenerate(config, input, env, label) {
  const { prompt, durationSeconds, image, video } = input;
  const payloadInput = { prompt, ...(durationSeconds ? { duration: durationSeconds } : {}) };
  if (image?.base64) payloadInput.image = `data:${image.mimeType || 'image/png'};base64,${image.base64}`;
  if (video?.base64) payloadInput.video = `data:${video.mimeType || 'video/mp4'};base64,${video.base64}`;
  const payload = await runReplicatePrediction(config, { version: config.version, input: payloadInput }, env, label);
  const output = Array.isArray(payload?.output) ? payload.output[0] : payload?.output;
  return resolveMediaPayload({ output, model: config.model }, label === 'VIDEO' ? 'video' : 'audio', config, env, label);
}

/* -------------------------------------------------------------------------- */
/*  Video editing (video-to-video)                                            */
/* -------------------------------------------------------------------------- */
//
// Genuine video EDITING (restyle / re-scene / re-light existing footage) is a
// distinct capability from generation: it needs a video-to-video model. This is
// deliberately a SEPARATE provider from createVideoProvider() so the system can
// report honestly that a generation-only backend (e.g. plain Veo) cannot edit.
// Configure either an operator HTTP editing endpoint or a Replicate model
// version that accepts { prompt, video }.

function videoEditHttpConfig(env) {
  if (!env.VIDEO_EDIT_HTTP_URL) return null;
  return { id: 'http', url: env.VIDEO_EDIT_HTTP_URL, secret: env.VIDEO_EDIT_HTTP_SECRET || '' };
}
function videoEditReplicateConfig(env) {
  const apiKey = env.REPLICATE_API_TOKEN;
  if (!apiKey || !env.REPLICATE_VIDEO_EDIT_VERSION) return null;
  return { id: 'replicate', apiKey, baseUrl: (env.REPLICATE_API_BASE || 'https://api.replicate.com/v1').replace(/\/$/, ''), version: env.REPLICATE_VIDEO_EDIT_VERSION, model: env.REPLICATE_VIDEO_EDIT_MODEL || 'replicate/video-edit', maxPolls: Number(env.REPLICATE_MAX_POLLS) || 60, pollIntervalMs: Number(env.REPLICATE_POLL_MS) || 2000 };
}
/** Resolve a genuine video-EDITING (video-to-video) provider. @returns {{id:string, edit:Function}|null} */
export function createVideoEditProvider(env = process.env) {
  const explicit = String(env.VIDEO_EDIT_PROVIDER || '').toLowerCase();
  const builders = [['http', videoEditHttpConfig], ['replicate', videoEditReplicateConfig]];
  const order = explicit ? builders.filter(([name]) => name === explicit) : builders;
  for (const [name, build] of order) {
    const config = build(env);
    if (!config) continue;
    if (name === 'http') return { id: 'http', model: 'http', edit: (input) => httpEditVideo(config, input, env) };
    if (name === 'replicate') return { id: 'replicate', model: config.model, edit: (input) => replicateEditVideo(config, input, env) };
  }
  return null;
}

async function httpEditVideo(config, { video, prompt, mimeType }, env) {
  const body = JSON.stringify({ video: { base64: video?.base64 ?? null, mimeType: mimeType || video?.mimeType || 'video/mp4' }, prompt });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'VIDEO_EDIT_TIMEOUT_MS', 300_000), config });
  const payload = await readJson(response, text, config);
  return resolveMediaPayload(payload, 'video', config, env, 'VIDEO_EDIT');
}

async function replicateEditVideo(config, { video, prompt, mimeType }, env) {
  const input = { prompt };
  if (video?.base64) input.video = `data:${mimeType || video.mimeType || 'video/mp4'};base64,${video.base64}`;
  const payload = await runReplicatePrediction(config, { version: config.version, input }, env, 'VIDEO_EDIT');
  const output = Array.isArray(payload?.output) ? payload.output[0] : payload?.output;
  return resolveMediaPayload({ output, model: config.model }, 'video', config, env, 'VIDEO_EDIT');
}

/* -------------------------------------------------------------------------- */
/*  Media analysis (audio / video understanding)                              */
/* -------------------------------------------------------------------------- */

function mediaAnalyzeHttpConfig(env) {
  if (!env.MEDIA_ANALYZE_HTTP_URL) return null;
  return { id: 'http', url: env.MEDIA_ANALYZE_HTTP_URL, secret: env.MEDIA_ANALYZE_HTTP_SECRET || '' };
}
/** Resolve a media-understanding provider (audio/video). @returns {{id:string, analyze:Function}|null} */
export function createMediaAnalysisProvider(env = process.env) {
  const config = mediaAnalyzeHttpConfig(env);
  if (!config) return null;
  return { id: 'http', model: 'http', analyze: (input) => httpAnalyzeMedia(config, input, env) };
}

async function httpAnalyzeMedia(config, { base64, mimeType, kind, prompt }, env) {
  const body = JSON.stringify({ media: { base64, mimeType, kind }, prompt: prompt ?? null });
  const headers = { 'content-type': 'application/json' };
  if (config.secret) headers['x-connector-signature'] = config.secret;
  const { response, text } = await fetchWithTimeout(config.url, { method: 'POST', headers, body }, { timeoutMs: timeoutMs(env, 'MEDIA_TIMEOUT_MS', 120_000) });
  const payload = await readJson(response, text, config);
  return { provider: config.id, model: payload?.model ?? 'http', text: payload?.text ?? payload?.analysis ?? payload?.description ?? '', usage: payload?.usage ?? null };
}

/** Report which connector families are configured (for honest status output). */
export function connectorStatus(env = process.env) {
  return {
    image: Boolean(createImageProvider(env)),
    vision: Boolean(createVisionProvider(env)),
    calendar: Boolean(createCalendarProvider(env)),
    email: Boolean(createEmailSendProvider(env)),
    slack: Boolean(createSlackProvider(env)),
    teams: Boolean(createTeamsProvider(env)),
    discord: Boolean(createDiscordProvider(env)),
    notion: Boolean(createNotionProvider(env)),
    webhook: Boolean(createWebhookProvider(env)),
    stt: Boolean(createSpeechToTextProvider(env)),
    tts: Boolean(createTextToSpeechProvider(env)),
    video: Boolean(createVideoProvider(env)),
    videoEdit: Boolean(createVideoEditProvider(env)),
    audio: Boolean(createAudioProvider(env)),
    mediaAnalysis: Boolean(createMediaAnalysisProvider(env)),
  };
}
