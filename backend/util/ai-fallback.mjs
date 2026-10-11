// ai-fallback.mjs
// ---------------------------------------------------------------------------
// Multi-provider AI fallback: Groq -> Gemini -> OpenRouter (first configured wins).
//
// Hardened version. What changed vs. the original snippet:
//   1. MODEL FIX (critical): the original used models that Google/Groq have
//      SHUT DOWN, so every call returned HTTP 404:
//        - Groq  `llama-3.3-70b-versatile`  -> shut down 2026-08-16
//          replacement: `openai/gpt-oss-120b`
//        - Gemini `gemini-1.5-flash`         -> shut down 2025-09-29
//          replacement: `gemini-3.5-flash-lite` (current stable Flash-Lite)
//      Models are now overridable via env (GROQ_MODEL / GEMINI_MODEL /
//      OPENROUTER_MODEL) so a future shutdown is a config change, not a code fix.
//   2. RETRY + BACKOFF: transient failures (408/409/425/429/5xx) are retried per
//      provider with exponential backoff, honouring the server's `Retry-After`
//      header and Gemini's `RetryInfo.retryDelay`. Auth/bad-request errors are
//      NOT retried (they would fail identically).
//   3. TIMEOUT: every request is bounded (default 20s) via AbortController so a
//      hung provider can never stall the server.
//   4. SECRETS: keys come ONLY from process.env. The Gemini key travels in the
//      `x-goog-api-key` header (never in the URL/query string), so it cannot
//      leak into logs or error messages.
//   5. DIAGNOSTICS: errors are truncated and a structured per-provider failure
//      list is attached to the final error.
//
// Usage:
//   import { callAIWithAdvancedFallback } from './ai-fallback.mjs';
//   const text = await callAIWithAdvancedFallback('Hello', 'You are helpful.');
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = Math.max(1_000, Number(process.env.AI_TIMEOUT_MS ?? 20_000));
const MAX_RETRIES = Math.max(0, Number(process.env.AI_MAX_RETRIES ?? 2)); // per provider
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(value, max = 300) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// Bounded exponential backoff; prefers the server's own Retry-After when given.
function retryDelayMs(attempt, retryAfterMs) {
  const base = Math.max(0, Number(process.env.AI_RETRY_BASE_MS ?? 500));
  const max = Math.max(base, Number(process.env.AI_MAX_RETRY_DELAY_MS ?? 15_000));
  const backoff = Math.min(base * 2 ** attempt, max);
  const delay = Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : backoff;
  return Math.min(delay, max);
}

// Parse `Retry-After` (seconds or HTTP-date) and Gemini's `RetryInfo` body hint.
function parseRetryAfterMs(headers, payload) {
  let raw = null;
  try {
    raw = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  } catch {
    raw = null;
  }
  if (raw != null && raw !== '') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const date = Date.parse(String(raw));
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const details = payload?.error?.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      const delay = detail?.retryDelay ?? detail?.retry_delay;
      const match = typeof delay === 'string' ? delay.match(/^([\d.]+)s$/) : null;
      if (match) return Math.round(Number(match[1]) * 1000);
    }
  }
  return undefined;
}

function buildProviders() {
  return [
    {
      name: 'Groq',
      key: process.env.GROQ_API_KEY,
      url: 'https://api.groq.com/openai/v1/chat/completions', // OpenAI-compatible
      // llama-3.3-70b-versatile was shut down 2026-08-16 -> gpt-oss-120b.
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
      body: (model, prompt, systemInstruction) => ({
        model,
        messages: [
          ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      extract: (data) => data.choices?.[0]?.message?.content,
    },
    {
      name: 'Gemini',
      key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      // gemini-1.5-flash was shut down 2025-09-29 -> current Flash-Lite.
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      url: (model) =>
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      // Key in the HEADER (not the query string) so it never leaks into logs.
      headers: (key) => ({ 'x-goog-api-key': key, 'Content-Type': 'application/json' }),
      body: (model, prompt, systemInstruction) => ({
        ...(systemInstruction ? { system_instruction: { parts: [{ text: systemInstruction }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      }),
      extract: (data) =>
        data.candidates?.[0]?.content?.parts?.map((part) => part?.text ?? '').join('') || undefined,
    },
    {
      name: 'OpenRouter',
      key: process.env.OPENROUTER_API_KEY,
      url: 'https://openrouter.ai/api/v1/chat/completions',
      // OpenRouter `:free` slugs rotate frequently — set OPENROUTER_MODEL explicitly
      // and verify it against https://openrouter.ai/models?max_price=0
      model: process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free',
      headers: (key) => ({
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(process.env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': process.env.OPENROUTER_SITE_URL } : {}),
        ...(process.env.OPENROUTER_APP_NAME ? { 'X-Title': process.env.OPENROUTER_APP_NAME } : {}),
      }),
      body: (model, prompt, systemInstruction) => ({
        model,
        messages: [
          ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      extract: (data) => data.choices?.[0]?.message?.content,
    },
  ];
}

async function requestProvider(provider, prompt, systemInstruction) {
  const url = typeof provider.url === 'function' ? provider.url(provider.model) : provider.url;
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('AI_TIMEOUT')), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: provider.headers(provider.key),
        body: JSON.stringify(provider.body(provider.model, prompt, systemInstruction)),
        signal: controller.signal,
      });

      const text = await response.text();
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text.slice(0, 500) };
      }

      if (response.ok) {
        const result = provider.extract(payload);
        if (!result) throw new Error('empty/unexpected response structure');
        return result;
      }

      const detail = truncate(
        payload?.error?.message ?? payload?.error ?? payload?.message ?? payload?.raw ?? response.statusText
      );
      const error = new Error(`HTTP ${response.status}: ${detail}`);
      error.status = response.status;

      const retryAfterMs = parseRetryAfterMs(response.headers, payload);
      if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;

      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_RETRIES) throw error;

      lastError = error;
      await sleep(retryDelayMs(attempt, retryAfterMs));
    } catch (error) {
      lastError = error;
      // Never retry a non-retryable HTTP status (auth / malformed request).
      if (attempt === MAX_RETRIES || (error?.status && !RETRYABLE_STATUS.has(error.status))) throw error;
      await sleep(retryDelayMs(attempt, error?.retryAfterMs));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error('AI_REQUEST_FAILED');
}

export async function callAIWithAdvancedFallback(prompt, systemInstruction = '') {
  const providers = buildProviders().filter((provider) => provider.key);

  if (!providers.length) {
    throw new Error(
      '[AI Error] No AI API keys found. Set GROQ_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), or OPENROUTER_API_KEY.'
    );
  }

  const failures = [];

  for (const provider of providers) {
    try {
      console.log(`[AI Fallback] Attempting ${provider.name} (model=${provider.model})`);
      const result = await requestProvider(provider, prompt, systemInstruction);
      console.log(`[AI Success] ${provider.name} responded successfully.`);
      return result;
    } catch (error) {
      const reason = truncate(error?.message ?? String(error), 200);
      console.warn(`[AI Warning] ${provider.name} failed: ${reason}. Trying next provider...`);
      failures.push({ provider: provider.name, model: provider.model, reason });
    }
  }

  const error = new Error(
    '[AI Fatal Error] All configured AI providers failed:\n' +
      failures.map((f) => `  - ${f.provider} (${f.model}): ${f.reason}`).join('\n')
  );
  error.failures = failures;
  throw error;
}

export default callAIWithAdvancedFallback;
