import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 45_000;
const RETRIES = 2;

function usage(raw = {}) {
  const promptTokens = Number(raw.prompt_tokens ?? raw.input_tokens ?? raw.promptTokenCount ?? 0);
  const completionTokens = Number(raw.completion_tokens ?? raw.output_tokens ?? raw.candidatesTokenCount ?? 0);
  const totalTokens = Number(raw.total_tokens ?? raw.totalTokenCount ?? promptTokens + completionTokens);
  return { promptTokens, completionTokens, totalTokens };
}

function withTimeout(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('LLM_TIMEOUT')), timeoutMs);
  const forward = () => controller.abort(signal?.reason ?? new Error('LLM_CANCELLED'));
  signal?.addEventListener?.('abort', forward, { once: true });
  return { signal: controller.signal, close: () => { clearTimeout(timer); signal?.removeEventListener?.('abort', forward); } };
}

async function requestJson(url, init, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const timeout = withTimeout(signal, timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: timeout.signal });
      const text = await response.text();
      let payload = {};
      try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 1000) }; }
      if (response.ok) return payload;
      const error = new Error(`LLM_HTTP_${response.status}`);
      error.status = response.status;
      error.payload = payload;
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt === RETRIES) throw error;
      lastError = error;
      await sleep(Math.min(500 * (2 ** attempt), 4000));
    } catch (error) {
      lastError = error;
      if (attempt === RETRIES || (error?.status && ![408, 429, 500, 502, 503, 504].includes(error.status))) throw error;
      await sleep(Math.min(500 * (2 ** attempt), 4000));
    } finally { timeout.close(); }
  }
  throw lastError ?? new Error('LLM_REQUEST_FAILED');
}

function openAiMessage(payload) {
  const message = payload?.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => ({
    id: call.id ?? `call_${Date.now()}`,
    name: call.function?.name,
    arguments: parseArguments(call.function?.arguments),
  })) : [];
  return { text: message.content ?? '', toolCalls, usage: usage(payload?.usage), provider: 'openai' };
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

async function openaiComplete({ apiKey, model, messages, tools, signal, baseUrl = 'https://api.openai.com/v1' }) {
  const payload = await requestJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, ...(tools?.length ? { tools, tool_choice: 'auto' } : {}) }),
  }, { signal });
  return openAiMessage(payload);
}

async function geminiComplete({ apiKey, model, messages, tools, signal }) {
  const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content ?? '') }],
  }));
  const system = messages.find((m) => m.role === 'system')?.content;
  const body = {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) }] } : {}),
  };
  const payload = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, { signal });
  const parts = payload?.candidates?.[0]?.content?.parts ?? [];
  const toolCalls = parts.filter((part) => part.functionCall).map((part, index) => ({ id: `gemini_call_${index}`, name: part.functionCall.name, arguments: part.functionCall.args ?? {} }));
  const text = parts.filter((part) => typeof part.text === 'string').map((part) => part.text).join('');
  return { text, toolCalls, usage: usage(payload?.usageMetadata), provider: 'gemini' };
}

async function anthropicComplete({ apiKey, model, messages, tools, signal }) {
  const system = messages.find((m) => m.role === 'system')?.content;
  const body = {
    model,
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '') })),
    ...(tools?.length ? { tools: tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}),
  };
  const payload = await requestJson('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, { signal });
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const toolCalls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} }));
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
  return { text, toolCalls, usage: usage(payload?.usage), provider: 'anthropic' };
}

export function createLLMRouter(env = process.env) {
  const providers = [
    env.OPENAI_API_KEY ? { id: 'openai', key: env.OPENAI_API_KEY, baseUrl: env.OPENAI_API_BASE || 'https://api.openai.com/v1', defaultModel: env.OPENAI_MODEL || 'gpt-5-mini' } : null,
    (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) ? { id: 'gemini', key: env.GEMINI_API_KEY || env.GOOGLE_API_KEY, defaultModel: env.GEMINI_MODEL || 'gemini-3-flash-preview' } : null,
    env.ANTHROPIC_API_KEY ? { id: 'anthropic', key: env.ANTHROPIC_API_KEY, defaultModel: env.ANTHROPIC_MODEL || 'claude-haiku-4-5' } : null,
  ].filter(Boolean);
  const health = new Map(providers.map((item) => [item.id, { failures: 0, unavailableUntil: 0 }]));
  const choose = (model) => {
    const lower = String(model || '').toLowerCase();
    const preferred = lower.includes('gemini') ? 'gemini' : lower.includes('claude') || lower.includes('anthropic') ? 'anthropic' : 'openai';
    return providers.find((item) => item.id === preferred) ?? providers[0];
  };
  return {
    status: () => providers.map(({ id, defaultModel }) => ({ id, model: defaultModel, configured: true, healthy: (health.get(id)?.unavailableUntil ?? 0) <= Date.now() })),
    async complete(input) {
      if (!providers.length) throw new Error('NO_SERVER_LLM_PROVIDER_CONFIGURED');
      const requested = String(input.model || '').toLowerCase();
      const explicitFamily = requested && !['default', 'auto'].includes(requested) ? (requested.includes('gemini') ? 'gemini' : requested.includes('claude') || requested.includes('anthropic') ? 'anthropic' : 'openai') : null;
      const ordered = [choose(input.model), ...providers].filter((item, index, all) => item && all.findIndex((candidate) => candidate.id === item.id) === index);
      const candidates = explicitFamily ? ordered.filter((item) => item.id === explicitFamily) : ordered;
      let lastError;
      for (const provider of candidates) {
        const state = health.get(provider.id);
        if (state?.unavailableUntil > Date.now()) continue;
        const model = explicitFamily ? input.model : (input.model && !['default', 'auto'].includes(input.model) ? input.model : provider.defaultModel);
        try {
          const result = provider.id === 'gemini'
            ? await geminiComplete({ ...input, apiKey: provider.key, model: explicitFamily ? model : provider.defaultModel })
            : provider.id === 'anthropic'
              ? await anthropicComplete({ ...input, apiKey: provider.key, model: explicitFamily ? model : provider.defaultModel })
              : await openaiComplete({ ...input, apiKey: provider.key, baseUrl: provider.baseUrl, model: explicitFamily ? model : provider.defaultModel });
          if (state) { state.failures = 0; state.unavailableUntil = 0; }
          return result;
        } catch (error) {
          lastError = error;
          if (state) { state.failures += 1; state.unavailableUntil = Date.now() + Math.min(60_000, 1_000 * (2 ** Math.min(state.failures, 6))); }
          if (explicitFamily) break;
        }
      }
      throw lastError ?? new Error('NO_HEALTHY_LLM_PROVIDER');
    },
  };
}
