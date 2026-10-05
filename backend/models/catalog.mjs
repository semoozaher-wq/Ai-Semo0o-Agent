// Single source of truth for server model IDs. UI aliases are normalized before reaching providers.
export const SUPPORTED_MODELS = Object.freeze({
  'gpt-5-mini': Object.freeze({ provider: 'openai', input: 0.25, output: 2.00, context: 200_000 }),
  'gpt-5': Object.freeze({ provider: 'openai', input: 1.25, output: 10.00, context: 400_000 }),

  'gemini-2.5-flash-lite': Object.freeze({ provider: 'gemini', input: 0, output: 0, context: 1_048_576 }),
  'gemini-3-flash-preview': Object.freeze({ provider: 'gemini', input: 0.50, output: 3.00, context: 1_000_000 }),
  'gemini-3.1-pro-preview': Object.freeze({ provider: 'gemini', input: 2.00, output: 12.00, context: 1_000_000 }),

  'claude-haiku-4-5': Object.freeze({ provider: 'anthropic', input: 1.00, output: 5.00, context: 200_000 }),
  'claude-sonnet-4-6': Object.freeze({ provider: 'anthropic', input: 3.00, output: 15.00, context: 200_000 }),
});

export const MODEL_ALIASES = Object.freeze({
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-pro': 'gemini-3.1-pro-preview',
  'claude-4.5-haiku': 'claude-haiku-4-5',
  'claude-4.5-sonnet': 'claude-sonnet-4-6',
});

export function normalizeModelId(model) {
  const value = String(model || '').trim();

  if (!value || value === 'default' || value === 'auto') {
    return 'gpt-5-mini';
  }

  const normalized = MODEL_ALIASES[value] || value;

  if (!SUPPORTED_MODELS[normalized]) {
    throw new Error(`UNSUPPORTED_MODEL:${value}`);
  }

  return normalized;
}

export function modelProvider(model) {
  return SUPPORTED_MODELS[
    normalizeModelId(model)
  ].provider;
}

export function modelCost(model, usage = {}) {
  const spec = SUPPORTED_MODELS[
    normalizeModelId(model)
  ];

  return (
    ((Number(usage.promptTokens) || 0) / 1_000_000) *
      spec.input
    +
    ((Number(usage.completionTokens) || 0) / 1_000_000) *
      spec.output
  );
}
