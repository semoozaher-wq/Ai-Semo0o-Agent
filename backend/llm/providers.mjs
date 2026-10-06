import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeModelId, modelProvider, defaultModelForProvider, isModelCompatible } from '../models/catalog.mjs';

const DEFAULT_TIMEOUT_MS = 45_000;
const RETRIES = 2;

// Statuses worth retrying: transient server/rate-limit/timeout conditions.
const RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504];

function truncateDetail(value, max = 300) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// A clear, actionable hint that names the exact env var to fix. This is what
// replaces the opaque `LLM_HTTP_404` an operator used to see.
function providerHint(provider, model) {
  if (provider === 'gemini') {
    return `Gemini does not serve model "${model}". Set GEMINI_MODEL to a supported Gemini model (e.g. gemini-2.5-flash-lite) or configure OPENAI_API_KEY for OpenAI models.`;
  }
  if (provider === 'anthropic') {
    return `Anthropic does not serve model "${model}". Set ANTHROPIC_MODEL to a supported Claude model (e.g. claude-haiku-4-5) or configure OPENAI_API_KEY.`;
  }
  if (provider === 'openai') {
    return `The OpenAI endpoint does not serve model "${model}". Set OPENAI_MODEL to a supported model (e.g. gpt-5-mini) or point OPENAI_API_BASE at a gateway that serves "${model}".`;
  }
  return `The configured provider does not serve model "${model}".`;
}

// Build a diagnostic error. A 404 is almost always "this provider does not
// serve this model" (wrong model for the endpoint, or a model whose real
// provider is not configured), so it is surfaced as LLM_MODEL_NOT_FOUND with
// provider/model/endpoint/hint instead of the opaque LLM_HTTP_404.
function buildHttpError(status, payload, context = {}) {
  const provider = context.provider ?? 'unknown';
  const model = context.model ?? 'unknown';
  const endpoint = context.endpoint ?? 'unknown';
  const detail = truncateDetail(
    payload?.error?.message ??
    payload?.error ??
    payload?.message ??
    payload?.raw ??
    ''
  );

  const isNotFound = status === 404;
  const code = isNotFound ? 'LLM_MODEL_NOT_FOUND' : `LLM_HTTP_${status}`;
  const hint = isNotFound ? providerHint(provider, model) : undefined;

  const error = new Error(
    `${code}: provider=${provider} model=${model} endpoint=${endpoint}` +
    `${detail ? ` detail=${detail}` : ''}` +
    `${hint ? ` hint=${hint}` : ''}`
  );

  error.code = code;
  error.status = status;
  error.provider = provider;
  error.model = model;
  error.endpoint = endpoint;
  if (hint) error.hint = hint;
  error.payload = payload;

  return error;
}

function usage(raw = {}) {
  const promptTokens = Number(
    raw.prompt_tokens ??
    raw.input_tokens ??
    raw.promptTokenCount ??
    raw.promptTokenCount ??
    0
  );

  const completionTokens = Number(
    raw.completion_tokens ??
    raw.output_tokens ??
    raw.candidatesTokenCount ??
    0
  );

  const totalTokens = Number(
    raw.total_tokens ??
    raw.totalTokenCount ??
    raw.totalTokenCount ??
    promptTokens + completionTokens
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function withTimeout(signal, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort(new Error('LLM_TIMEOUT'));
  }, timeoutMs);

  const forward = () => {
    controller.abort(
      signal?.reason ??
      new Error('LLM_CANCELLED')
    );
  };

  signal?.addEventListener?.('abort', forward, {
    once: true,
  });

  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', forward);
    },
  };
}

async function requestJson(
  url,
  init,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS, context = {} } = {}
) {
  let lastError;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const timeout = withTimeout(signal, timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: timeout.signal,
      });

      const text = await response.text();

      let payload = {};

      try {
        payload = text
          ? JSON.parse(text)
          : {};
      } catch {
        payload = {
          raw: text.slice(0, 1000),
        };
      }

      if (response.ok) {
        return payload;
      }

      const error = buildHttpError(
        response.status,
        payload,
        { ...context, endpoint: url }
      );

      if (
        !RETRYABLE_STATUS.includes(
          response.status
        ) ||
        attempt === RETRIES
      ) {
        throw error;
      }

      lastError = error;

      await sleep(
        Math.min(
          500 * (2 ** attempt),
          4000
        )
      );
    } catch (error) {
      lastError = error;

      if (
        attempt === RETRIES ||
        (
          error?.status &&
          !RETRYABLE_STATUS.includes(
            error.status
          )
        )
      ) {
        throw error;
      }

      await sleep(
        Math.min(
          500 * (2 ** attempt),
          4000
        )
      );
    } finally {
      timeout.close();
    }
  }

  throw lastError ?? new Error('LLM_REQUEST_FAILED');
}

function openAiMessage(payload) {
  const message =
    payload?.choices?.[0]?.message ?? {};

  const toolCalls =
    Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => ({
          id:
            call.id ??
            `call_${Date.now()}`,
          name: call.function?.name,
          arguments: parseArguments(
            call.function?.arguments
          ),
        }))
      : [];

  return {
    text: message.content ?? '',
    toolCalls,
    usage: usage(payload?.usage),
    provider: 'openai',
  };
}

function parseArguments(value) {
  if (
    value &&
    typeof value === 'object'
  ) {
    return value;
  }

  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

async function openaiComplete({
  apiKey,
  model,
  messages,
  tools,
  signal,
  baseUrl = 'https://api.openai.com/v1',
}) {
  const payload = await requestJson(
    `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools?.length
          ? {
              tools,
              tool_choice: 'auto',
            }
          : {}),
      }),
    },
    { signal, context: { provider: 'openai', model } }
  );

  return openAiMessage(payload);
}

function geminiText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    return JSON.stringify(value);
  }

  return String(value ?? '');
}

function sanitizeGeminiSchema(schema) {
  if (
    !schema ||
    typeof schema !== 'object'
  ) {
    return {
      type: 'OBJECT',
    };
  }

  const allowed = new Set([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'items',
    'properties',
    'required',
    'propertyOrdering',
  ]);

  const output = {};

  for (const [
    key,
    value,
  ] of Object.entries(schema)) {
    if (!allowed.has(key)) {
      continue;
    }

    if (key === 'properties' && value && typeof value === 'object') {
      output.properties = Object.fromEntries(
        Object.entries(value).map(
          ([name, property]) => [
            name,
            sanitizeGeminiSchema(property),
          ]
        )
      );
      continue;
    }

    if (key === 'items') {
      output.items =
        sanitizeGeminiSchema(value);
      continue;
    }

    output[key] = value;
  }

  if (typeof output.type === 'string') {
    output.type =
      output.type.toUpperCase();
  }

  return output;
}

function geminiFunctionDeclarations(
  tools
) {
  return (tools ?? [])
    .map((tool) => {
      const fn = tool?.function;

      if (!fn?.name) {
        return null;
      }

      return {
        name: fn.name,
        ...(fn.description
          ? {
              description:
                fn.description,
            }
          : {}),
        parameters:
          fn.parameters
            ? sanitizeGeminiSchema(
                fn.parameters
              )
            : {
                type: 'OBJECT',
              },
      };
    })
    .filter(Boolean);
}

async function geminiComplete({
  apiKey,
  model,
  messages,
  tools,
  signal,
}) {
  const sourceMessages =
    Array.isArray(messages)
      ? messages
      : [];

  const systemParts =
    sourceMessages
      .filter(
        (message) =>
          message?.role === 'system'
      )
      .map((message) => ({
        text: geminiText(
          message?.content
        ),
      }))
      .filter(
        (part) =>
          part.text.trim().length > 0
      );

  const contents =
    sourceMessages
      .filter(
        (message) =>
          message?.role !== 'system'
      )
      .map((message) => {
        const role =
          message?.role === 'assistant'
            ? 'model'
            : 'user';

        return {
          role,
          parts: [
            {
              text: geminiText(
                message?.content
              ),
            },
          ],
        };
      })
      .filter(
        (message) =>
          message.parts.some(
            (part) =>
              typeof part.text ===
                'string' &&
              part.text.length > 0
          )
      );

  /*
   * Gemini requires contents to contain at least
   * one user/model content. Keep the request valid
   * even if the caller only supplied system messages.
   */
  if (!contents.length) {
    contents.push({
      role: 'user',
      parts: [
        {
          text: 'Continue.',
        },
      ],
    });
  }

  const body = {
    ...(systemParts.length
      ? {
          system_instruction: {
            parts: systemParts,
          },
        }
      : {}),
    contents,
  };

  const functionDeclarations =
    geminiFunctionDeclarations(
      tools
    );

  if (functionDeclarations.length) {
    body.tools = [
      {
        functionDeclarations,
      },
    ];

    body.tool_config = {
      function_calling_config: {
        mode: 'AUTO',
      },
    };
  }

  const payload =
    await requestJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type':
            'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      },
      { signal, context: { provider: 'gemini', model } }
    );

  const candidate =
    payload?.candidates?.[0];

  const parts =
    candidate?.content?.parts ?? [];

  const text = parts
    .filter(
      (part) =>
        typeof part?.text ===
        'string'
    )
    .map(
      (part) =>
        part.text
    )
    .join('');

  const toolCalls = parts
    .filter(
      (part) =>
        part?.functionCall
    )
    .map((part, index) => ({
      id:
        part.functionCall?.id ??
        `call_${Date.now()}_${index}`,
      name:
        part.functionCall?.name,
      arguments:
        part.functionCall?.args ?? {},
    }));

  return {
    text,
    toolCalls,
    usage: usage(
      payload?.usageMetadata
    ),
    provider: 'gemini',
  };
}

async function anthropicComplete({
  apiKey,
  model,
  messages,
  tools,
  signal,
}) {
  const system = messages
    .filter(
      (message) =>
        message.role === 'system'
    )
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(
            message.content ?? ''
          )
    )
    .join('\n\n');

  const inputMessages = messages
    .filter(
      (message) =>
        message.role !== 'system'
    )
    .map((message) => ({
      role:
        message.role === 'assistant'
          ? 'assistant'
          : 'user',
      content:
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(
              message.content ?? ''
            ),
    }));

  const body = {
    model,
    max_tokens: 4096,
    messages: inputMessages,
    ...(system ? { system } : {}),
  };

  if (tools?.length) {
    body.tools = tools
      .map(
        (tool) =>
          tool?.function
      )
      .filter(Boolean)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema:
          tool.parameters ?? {
            type: 'object',
          },
      }));
  }

  const payload = await requestJson(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version':
          '2023-06-01',
        'content-type':
          'application/json',
      },
      body: JSON.stringify(body),
    },
    { signal }
  );

  const content =
    Array.isArray(payload?.content)
      ? payload.content
      : [];

  const text = content
    .filter(
      (part) =>
        part?.type === 'text'
    )
    .map(
      (part) =>
        part.text
    )
    .join('');

  const toolCalls = content
    .filter(
      (part) =>
        part?.type === 'tool_use'
    )
    .map((part) => ({
      id:
        part.id ??
        `call_${Date.now()}`,
      name: part.name,
      arguments:
        part.input ?? {},
    }));

  return {
    text,
    toolCalls,
    usage: usage(
      payload?.usage
    ),
    provider: 'anthropic',
  };
}

// -----------------------------------------------------------------------------
// Streaming (Server-Sent Events) support.
//
// `POST /chat/stream` consumes `llm.stream(...)` as an async generator of frames:
//   { type: 'token', text }                          -> an incremental answer chunk
//   { type: 'done', text, usage, provider, model }   -> the terminal frame
//
// Each provider is streamed in its own native wire format and normalised to the
// frames above. Streaming is a transport optimisation, never a hard requirement:
// when the runtime cannot expose a readable body, `readSse` throws
// `LLM_STREAM_UNSUPPORTED` and the router falls back to a buffered completion.
// -----------------------------------------------------------------------------

function parseSseBlock(block) {
  const lines = block.split('\n');
  let event;
  const dataLines = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }

  if (!dataLines.length) {
    return null;
  }

  return { event, data: dataLines.join('\n') };
}

async function* readSse(response) {
  const body = response.body;

  if (!body || typeof body.getReader !== 'function') {
    const error = new Error('LLM_STREAM_UNSUPPORTED: response body is not a readable stream');
    error.code = 'LLM_STREAM_UNSUPPORTED';
    throw error;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Normalise CRLF so both `\n\n` and `\r\n\r\n` frame separators are handled.
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const parsed = parseSseBlock(block);
      if (parsed) yield parsed;
      boundary = buffer.indexOf('\n\n');
    }
  }

  const trailing = parseSseBlock(buffer);
  if (trailing) yield trailing;
}

async function readStreamError(response, context) {
  const text = await response.text().catch(() => '');
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 1000) };
  }

  return buildHttpError(response.status, payload, context);
}

async function* openaiStream({
  apiKey,
  model,
  messages,
  tools,
  signal,
  baseUrl = 'https://api.openai.com/v1',
}) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const timeout = withTimeout(signal);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: timeout.signal,
    });

    if (!response.ok) {
      throw await readStreamError(response, { provider: 'openai', model, endpoint: url });
    }

    let usageRaw = null;
    let text = '';

    for await (const event of readSse(response)) {
      if (!event.data || event.data === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        continue;
      }

      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length) {
        text += delta;
        yield { type: 'token', text: delta };
      }

      if (chunk?.usage) usageRaw = chunk.usage;
    }

    yield { type: 'done', text, usage: usage(usageRaw ?? {}), provider: 'openai' };
  } finally {
    timeout.close();
  }
}

async function* anthropicStream({ apiKey, model, messages, tools, signal }) {
  const system = (messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')))
    .join('\n\n');

  const inputMessages = (messages ?? [])
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
    }));

  const body = {
    model,
    max_tokens: 4096,
    stream: true,
    messages: inputMessages,
    ...(system ? { system } : {}),
  };

  if (tools?.length) {
    body.tools = tools
      .map((tool) => tool?.function)
      .filter(Boolean)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters ?? { type: 'object' },
      }));
  }

  const url = 'https://api.anthropic.com/v1/messages';
  const timeout = withTimeout(signal);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });

    if (!response.ok) {
      throw await readStreamError(response, { provider: 'anthropic', model, endpoint: url });
    }

    let usageRaw = null;
    let text = '';

    for await (const event of readSse(response)) {
      if (!event.data) continue;

      let chunk;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        continue;
      }

      if (event.event === 'content_block_delta' && typeof chunk?.delta?.text === 'string') {
        text += chunk.delta.text;
        yield { type: 'token', text: chunk.delta.text };
      } else if (event.event === 'message_start' && chunk?.message?.usage) {
        usageRaw = { ...(usageRaw ?? {}), ...chunk.message.usage };
      } else if (event.event === 'message_delta' && chunk?.usage) {
        usageRaw = { ...(usageRaw ?? {}), ...chunk.usage };
      }
    }

    yield { type: 'done', text, usage: usage(usageRaw ?? {}), provider: 'anthropic' };
  } finally {
    timeout.close();
  }
}

async function* geminiStream({ apiKey, model, messages, tools, signal }) {
  const sourceMessages = Array.isArray(messages) ? messages : [];

  const systemParts = sourceMessages
    .filter((message) => message?.role === 'system')
    .map((message) => ({ text: geminiText(message?.content) }))
    .filter((part) => part.text.trim().length > 0);

  const contents = sourceMessages
    .filter((message) => message?.role !== 'system')
    .map((message) => ({
      role: message?.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: geminiText(message?.content) }],
    }))
    .filter((message) => message.parts.some((part) => typeof part.text === 'string' && part.text.length > 0));

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Continue.' }] });
  }

  const body = {
    ...(systemParts.length ? { system_instruction: { parts: systemParts } } : {}),
    contents,
  };

  const functionDeclarations = geminiFunctionDeclarations(tools);
  if (functionDeclarations.length) {
    body.tools = [{ functionDeclarations }];
    body.tool_config = { function_calling_config: { mode: 'AUTO' } };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const timeout = withTimeout(signal);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: timeout.signal,
    });

    if (!response.ok) {
      throw await readStreamError(response, { provider: 'gemini', model, endpoint: url });
    }

    let usageRaw = null;
    let text = '';

    for await (const event of readSse(response)) {
      if (!event.data) continue;

      let chunk;
      try {
        chunk = JSON.parse(event.data);
      } catch {
        continue;
      }

      const parts = chunk?.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part?.text === 'string' && part.text.length) {
          text += part.text;
          yield { type: 'token', text: part.text };
        }
      }

      if (chunk?.usageMetadata) usageRaw = chunk.usageMetadata;
    }

    yield { type: 'done', text, usage: usage(usageRaw ?? {}), provider: 'gemini' };
  } finally {
    timeout.close();
  }
}

async function* streamProvider({ provider, model, input }) {
  if (provider.id === 'gemini') {
    yield* geminiStream({ ...input, apiKey: provider.key, model });
    return;
  }

  if (provider.id === 'anthropic') {
    yield* anthropicStream({ ...input, apiKey: provider.key, model });
    return;
  }

  yield* openaiStream({ ...input, apiKey: provider.key, baseUrl: provider.baseUrl, model });
}

export function createLLMRouter(
  env = process.env
) {
  const providers = [
    env.OPENAI_API_KEY
      ? {
          id: 'openai',
          key: env.OPENAI_API_KEY,
          baseUrl:
            env.OPENAI_API_BASE ||
            'https://api.openai.com/v1',
          defaultModel:
            env.OPENAI_MODEL ||
            'gpt-5-mini',
        }
      : null,

    (
      env.GEMINI_API_KEY ||
      env.GOOGLE_API_KEY
    )
      ? {
          id: 'gemini',
          key:
            env.GEMINI_API_KEY ||
            env.GOOGLE_API_KEY,
          defaultModel:
            env.GEMINI_MODEL ||
            'gemini-2.5-flash-lite',
        }
      : null,

    env.ANTHROPIC_API_KEY
      ? {
          id: 'anthropic',
          key:
            env.ANTHROPIC_API_KEY,
          defaultModel:
            env.ANTHROPIC_MODEL ||
            'claude-haiku-4-5',
        }
      : null,
  ].filter(Boolean);

  const health = new Map(
    providers.map((item) => [
      item.id,
      {
        failures: 0,
        unavailableUntil: 0,
      },
    ])
  );

  const getProvider = (id) =>
    providers.find(
      (item) =>
        item.id === id
    );

  const markFailure = (
    provider
  ) => {
    const state =
      health.get(provider.id);

    if (!state) {
      return;
    }

    state.failures += 1;

    state.unavailableUntil =
      Date.now() +
      Math.min(
        60_000,
        1_000 *
          (
            2 **
            Math.min(
              state.failures,
              6
            )
          )
      );
  };

  const markSuccess = (
    provider
  ) => {
    const state =
      health.get(provider.id);

    if (!state) {
      return;
    }

    state.failures = 0;
    state.unavailableUntil = 0;
  };

  const executeProvider = async ({
    provider,
    model,
    input,
  }) => {
    if (provider.id === 'gemini') {
      return geminiComplete({
        ...input,
        apiKey: provider.key,
        model,
      });
    }

    if (provider.id === 'anthropic') {
      return anthropicComplete({
        ...input,
        apiKey: provider.key,
        model,
      });
    }

    return openaiComplete({
      ...input,
      apiKey: provider.key,
      baseUrl: provider.baseUrl,
      model,
    });
  };

  // Resolve a model that is GUARANTEED to be served by `provider`. Prefers the
  // operator-configured default (env OPENAI_MODEL / GEMINI_MODEL / ANTHROPIC_MODEL)
  // when it is valid for that provider, otherwise the catalog default. This is
  // what makes cross-provider remapping safe: the result always belongs to the
  // provider, so it can never produce a 404 model-not-found.
  const compatibleModelFor = (provider) => {
    try {
      const configured =
        normalizeModelId(
          provider.defaultModel
        );

      if (
        isModelCompatible(
          configured,
          provider.id
        )
      ) {
        return configured;
      }
    } catch {
      /* fall through to the catalog default */
    }

    return defaultModelForProvider(
      provider.id
    );
  };

  const substitutionNotices = new Set();

  return {
    status: () =>
      providers.map(
        ({
          id,
          defaultModel,
        }) => ({
          id,
          model: defaultModel,
          configured: true,
          healthy:
            (
              health.get(id)
                ?.unavailableUntil ?? 0
            ) <= Date.now(),
        })
      ),

    async complete(input) {
      if (!providers.length) {
        const error = new Error(
          'NO_SERVER_LLM_PROVIDER_CONFIGURED: set at least one of OPENAI_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), ANTHROPIC_API_KEY'
        );
        error.code = 'NO_SERVER_LLM_PROVIDER_CONFIGURED';
        throw error;
      }

      const normalized =
        normalizeModelId(
          input.model
        );

      const requestedFamily =
        modelProvider(
          normalized
        );

      /*
       * ROOT-CAUSE FIX (LLM_HTTP_404)
       *
       * A model is only ever dispatched to a provider that actually serves its
       * family. Previously the requested model ID was sent verbatim to whichever
       * provider happened to be configured first, so an OpenAI model such as
       * `gpt-5` was POSTed to the Gemini endpoint and Gemini answered 404
       * (model not found).
       *
       *   1. If the requested model's provider IS configured -> use it with the
       *      EXACT requested model. A failure here is a real provider error and
       *      is surfaced as-is (never silently swapped for another family).
       *   2. If the requested model's provider is NOT configured -> remap to a
       *      configured provider using THAT provider's own compatible model.
       *      This is a transparent substitution (flagged on the result and
       *      logged), never a fake response.
       */
      const familyProvider =
        getProvider(
          requestedFamily
        );

      if (familyProvider) {
        const result =
          await executeProvider({
            provider: familyProvider,
            model: normalized,
            input,
          });

        markSuccess(familyProvider);

        return {
          ...result,
          model: normalized,
          requestedModel: normalized,
          substituted: false,
        };
      }

      let lastError;

      for (const provider of providers) {
        const model =
          compatibleModelFor(
            provider
          );

        // Hard invariant: never send a model to a provider that does not serve it.
        if (
          !isModelCompatible(
            model,
            provider.id
          )
        ) {
          throw new Error(
            `LLM_MODEL_PROVIDER_MISMATCH: provider=${provider.id} model=${model}`
          );
        }

        try {
          const result =
            await executeProvider({
              provider,
              model,
              input,
            });

          markSuccess(provider);

          const noticeKey =
            `${normalized}->${provider.id}:${model}`;

          if (
            !substitutionNotices.has(
              noticeKey
            )
          ) {
            substitutionNotices.add(
              noticeKey
            );

            process.emitWarning(
              `llm: requested model "${normalized}" belongs to provider "${requestedFamily}", which is not configured; using "${model}" on "${provider.id}" instead`,
              { code: 'LLM_MODEL_SUBSTITUTED' }
            );
          }

          return {
            ...result,
            model,
            requestedModel: normalized,
            substituted: true,
          };
        } catch (error) {
          lastError = error;
          markFailure(provider);
        }
      }

      throw lastError ?? new Error(
        `NO_HEALTHY_LLM_PROVIDER:${normalized}:${requestedFamily}`
      );
    },

    /*
     * Streaming counterpart of `complete`. It resolves the exact same
     * provider/model pair (a model is only ever streamed to a provider that
     * serves its family; an unconfigured family is transparently remapped to a
     * compatible model) and yields normalised frames:
     *   { type: 'token', text }  and a terminal { type: 'done', ... }.
     *
     * If the runtime cannot stream the provider response, it degrades to a
     * single-shot completion delivered as one token frame, so the endpoint
     * always produces a valid SSE response.
     */
    async *stream(input = {}) {
      if (!providers.length) {
        const error = new Error(
          'NO_SERVER_LLM_PROVIDER_CONFIGURED: set at least one of OPENAI_API_KEY, GEMINI_API_KEY (or GOOGLE_API_KEY), ANTHROPIC_API_KEY'
        );
        error.code = 'NO_SERVER_LLM_PROVIDER_CONFIGURED';
        throw error;
      }

      const normalized = normalizeModelId(input.model);
      const requestedFamily = modelProvider(normalized);
      const familyProvider = getProvider(requestedFamily);

      let provider;
      let model;
      let substituted;

      if (familyProvider) {
        provider = familyProvider;
        model = normalized;
        substituted = false;
      } else {
        provider =
          providers.find(
            (item) => (health.get(item.id)?.unavailableUntil ?? 0) <= Date.now()
          ) ?? providers[0];
        model = compatibleModelFor(provider);
        substituted = true;
      }

      // Hard invariant: never stream a model to a provider that does not serve it.
      if (!isModelCompatible(model, provider.id)) {
        throw new Error(
          `LLM_MODEL_PROVIDER_MISMATCH: provider=${provider.id} model=${model}`
        );
      }

      try {
        for await (const frame of streamProvider({ provider, model, input })) {
          if (frame.type === 'done') {
            markSuccess(provider);
            yield { ...frame, model, requestedModel: normalized, substituted };
          } else {
            yield frame;
          }
        }
      } catch (error) {
        if (error?.code === 'LLM_STREAM_UNSUPPORTED') {
          const result = await executeProvider({ provider, model, input });
          markSuccess(provider);

          if (result.text) {
            yield { type: 'token', text: result.text };
          }

          yield {
            type: 'done',
            text: result.text,
            usage: result.usage,
            provider: provider.id,
            model,
            requestedModel: normalized,
            substituted,
          };
          return;
        }

        markFailure(provider);
        throw error;
      }
    },
  };
}
