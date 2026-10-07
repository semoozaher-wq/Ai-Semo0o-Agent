import { createHash } from 'node:crypto';

// Local, dependency-free embedding used as the always-available fallback. It is
// deterministic and good enough for lexical+semantic hybrid search, but a real
// embedding model gives materially better recall, so a managed provider is
// preferred whenever one is configured.
export const LOCAL_EMBEDDING_MODEL = 'local-hash-v1';
export const LOCAL_EMBEDDING_DIMENSIONS = 64;

function tokens(text) { return String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []; }

export function localEmbedding(text, dimensions = LOCAL_EMBEDDING_DIMENSIONS) {
  const vector = Array(dimensions).fill(0);
  for (const token of tokens(text)) {
    const hash = parseInt(createHash('sha256').update(token).digest('hex').slice(0, 8), 16);
    vector[hash % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

async function fetchJson(url, { method = 'POST', headers = {}, body, timeoutMs = 20000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('EMBEDDING_TIMEOUT')), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'error' });
    } catch {
      // Never leak the request URL (which may carry a credential) through a
      // transport error. Preserve our timeout code; otherwise report a stable,
      // URL-free code.
      if (controller.signal.aborted) throw new Error('EMBEDDING_TIMEOUT');
      throw new Error('EMBEDDING_PROVIDER_UNREACHABLE');
    }
    const text = await response.text();
    if (text.length > maxBytes) throw new Error('EMBEDDING_RESPONSE_TOO_LARGE');
    if (!response.ok) throw new Error(`EMBEDDING_PROVIDER_${response.status}`);
    try { return JSON.parse(text); } catch { throw new Error('EMBEDDING_PROVIDER_INVALID_RESPONSE'); }
  } finally {
    clearTimeout(timer);
  }
}

function normalizeVectors(data) {
  const raw = data?.data ?? data?.embeddings ?? data?.vectors;
  if (!Array.isArray(raw)) throw new Error('EMBEDDING_PROVIDER_INVALID_RESPONSE');
  return raw.map((entry) => {
    const vector = entry?.embedding ?? entry?.vector ?? entry;
    if (!Array.isArray(vector) || vector.length === 0 || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('EMBEDDING_PROVIDER_INVALID_VECTOR');
    }
    return vector;
  });
}

/**
 * Build a managed embedding provider from the environment. Returns null when no
 * provider is configured so callers can fall back to the local embedder instead
 * of failing. The returned object exposes `model`, `dimensions` (best-effort,
 * resolved lazily on first call) and `embed(text) => Promise<number[]>`.
 */
export function createEmbeddingProvider(env = process.env) {
  const provider = String(env.EMBEDDING_PROVIDER || '').toLowerCase();
  if (!provider) return null;

  const timeoutMs = Number(env.EMBEDDING_TIMEOUT_MS || 20000);

  if (provider === 'openai' || provider === 'azure-openai' || provider === 'custom') {
    const endpoint = env.EMBEDDING_API_URL || (provider === 'openai' ? 'https://api.openai.com/v1/embeddings' : null);
    const apiKey = env.EMBEDDING_API_KEY || env.OPENAI_API_KEY;
    const model = env.EMBEDDING_MODEL || 'text-embedding-3-small';
    if (!endpoint) throw new Error('EMBEDDING_ENDPOINT_REQUIRED');
    if (!apiKey) throw new Error('EMBEDDING_API_KEY_REQUIRED');
    return {
      provider,
      model,
      dimensions: null,
      async embed(text) {
        const data = await fetchJson(endpoint, {
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ input: String(text), model }),
          timeoutMs,
        });
        const [vector] = normalizeVectors(data);
        this.dimensions = vector.length;
        return vector;
      },
    };
  }

  if (provider === 'gemini' || provider === 'google') {
    const apiKey = env.EMBEDDING_API_KEY || env.GEMINI_API_KEY;
    const model = env.EMBEDDING_MODEL || 'text-embedding-004';
    if (!apiKey) throw new Error('EMBEDDING_API_KEY_REQUIRED');
    // The key is sent in the `x-goog-api-key` header, never the URL query, so it
    // cannot leak through logs, proxies, referrers or error messages.
    const endpoint = env.EMBEDDING_API_URL || `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;
    return {
      provider: 'gemini',
      model,
      dimensions: null,
      async embed(text) {
        const data = await fetchJson(endpoint, {
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({ content: { parts: [{ text: String(text) }] } }),
          timeoutMs,
        });
        const vector = data?.embedding?.values;
        if (!Array.isArray(vector) || !vector.length) throw new Error('EMBEDDING_PROVIDER_INVALID_VECTOR');
        this.dimensions = vector.length;
        return vector;
      },
    };
  }

  if (provider === 'http') {
    const endpoint = env.EMBEDDING_API_URL;
    if (!endpoint) throw new Error('EMBEDDING_ENDPOINT_REQUIRED');
    const secret = env.EMBEDDING_API_KEY;
    const model = env.EMBEDDING_MODEL || 'http';
    return {
      provider: 'http',
      model,
      dimensions: null,
      async embed(text) {
        const data = await fetchJson(endpoint, {
          headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
          body: JSON.stringify({ input: String(text), model }),
          timeoutMs,
        });
        const [vector] = normalizeVectors(data);
        this.dimensions = vector.length;
        return vector;
      },
    };
  }

  throw new Error(`EMBEDDING_PROVIDER_UNSUPPORTED:${provider}`);
}

export function embeddingStatus(env = process.env) {
  try {
    const provider = createEmbeddingProvider(env);
    return provider ? { configured: true, provider: provider.provider, model: provider.model } : { configured: false, provider: 'local', model: LOCAL_EMBEDDING_MODEL };
  } catch (error) {
    return { configured: false, provider: 'local', model: LOCAL_EMBEDDING_MODEL, error: error instanceof Error ? error.message : String(error) };
  }
}
