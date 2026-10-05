import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeModelId, modelProvider } from '../models/catalog.mjs';

const DEFAULT_TIMEOUT_MS = 45_000;
const RETRIES = 2;

function usage(raw = {}) {
  const promptTokens = Number(
    raw.prompt_tokens ??
    raw.input_tokens ??
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
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
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

      const error = new Error(
        `LLM_HTTP_${response.status}`
      );

      error.status = response.status;
      error.payload = payload;

      if (
        ![408, 429, 500, 502, 503, 504].includes(
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
          ![408, 429, 500, 502, 503, 504].includes(
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
    { signal }
  );

  return openAiMessage(payload);
}

async function geminiComplete({
  apiKey,
  model,
  messages,
  tools,
  signal,
}) {
  const contents = messages
    .filter(
      (message) =>
        message.role !== 'system'
    )
    .map((message) => ({
      role:
        message.role === 'assistant'
          ? 'model'
          : 'user',
      parts: [
        {
          text:
            typeof message.content === 'string'
              ? message.content
              : JSON.stringify(
                  message.content ?? ''
                ),
        },
      ],
    }));

  const systemInstruction = messages
    .filter(
      (message) =>
        message.role === 'system'
    )
    .map((message) => ({
      text:
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(
              message.content ?? ''
            ),
    }));

  const body = {
    ...(systemInstruction.length
      ? {
          systemInstruction: {
            parts: systemInstruction,
          },
        }
      : {}),
    contents,
  };

  if (tools?.length) {
    body.tools = [
      {
        functionDeclarations: tools
          .map(
            (tool) =>
              tool?.function
          )
          .filter(Boolean),
      },
    ];
  }

  const payload = await requestJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    { signal }
  );

  const candidate =
    payload?.candidates?.[0];

  const parts =
    candidate?.content?.parts ?? [];

  const text = parts
    .filter(
      (part) =>
        typeof part?.text === 'string'
    )
    .map((part) => part.text)
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

  const choose = (model) => {
    const lower =
      String(model || '')
        .toLowerCase();

    const preferred =
      lower.includes('gemini')
        ? 'gemini'
        : lower.includes('claude') ||
            lower.includes('anthropic')
          ? 'anthropic'
          : 'openai';

    return (
      providers.find(
        (item) =>
          item.id === preferred
      ) ?? providers[0]
    );
  };

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
        throw new Error(
          'NO_SERVER_LLM_PROVIDER_CONFIGURED'
        );
      }

      const normalized =
        normalizeModelId(
          input.model
        );

      const explicitFamily =
        modelProvider(
          normalized
        );

      const primary =
        getProvider(
          explicitFamily
        ) ?? choose(normalized);

      if (!primary) {
        throw new Error(
          `NO_PROVIDER_FOR_MODEL:${normalized}:${explicitFamily}`
        );
      }

      let lastError;

      /*
       * PRIMARY PROVIDER
       *
       * Respect the requested model exactly.
       */
      try {
        const result =
          await executeProvider({
            provider: primary,
            model: normalized,
            input,
          });

        markSuccess(primary);

        return result;
      } catch (error) {
        lastError = error;
        markFailure(primary);

        /*
         * FALLBACK
         *
         * If OpenAI fails, try Gemini automatically.
         * Gemini receives its own configured/default model
         * instead of receiving an OpenAI model ID.
         */
        if (
          primary.id === 'openai'
        ) {
          const gemini =
            getProvider(
              'gemini'
            );

          if (gemini) {
            try {
              const geminiModel =
                normalizeModelId(
                  gemini.defaultModel
                );

              const result =
                await executeProvider({
                  provider: gemini,
                  model: geminiModel,
                  input,
                });

              markSuccess(gemini);

              return result;
            } catch (fallbackError) {
              lastError =
                fallbackError;
              markFailure(
                gemini
              );
            }
          }
        }

        /*
         * Preserve the existing Anthropic support.
         * It is not used as the OpenAI → Gemini fallback,
         * but remains available when explicitly selected.
         */
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error(
        `NO_HEALTHY_LLM_PROVIDER:${normalized}:${explicitFamily}`
      );
    },
  };
}
