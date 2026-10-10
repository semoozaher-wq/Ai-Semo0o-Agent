// Single source of truth for server model IDs. UI aliases are normalized before reaching providers.
//
// NOTE ON GOOGLE MODELS (verified against ai.google.dev/gemini-api/docs/models,
// last updated 2026-10-09): Google now LIMITS access to the 2.5 family to
// accounts that already used it ("For any new projects, use our latest models:
// 3.5 Flash-Lite or 3.8 Flash."). A fresh API key therefore gets 404/429 for
// `gemini-2.5-flash-lite`, which is exactly the failure that produced
// MAESTRO_ALL_MODELS_FAILED. The Gemini default is now `gemini-3.5-flash-lite`
// (Stable, recommended for new projects). The old id is kept as an alias so any
// persisted config/UI value still resolves to a served model.
export const SUPPORTED_MODELS = Object.freeze({
  'gpt-5-mini': Object.freeze({ provider: 'openai', input: 0.25, output: 2.00, context: 200_000 }),
  'gpt-5': Object.freeze({ provider: 'openai', input: 1.25, output: 10.00, context: 400_000 }),

  'gemini-3.5-flash-lite': Object.freeze({ provider: 'gemini', input: 0.10, output: 0.40, context: 1_000_000 }),
  'gemini-3-flash-preview': Object.freeze({ provider: 'gemini', input: 0.50, output: 3.00, context: 1_000_000 }),
  'gemini-3.1-pro-preview': Object.freeze({ provider: 'gemini', input: 2.00, output: 12.00, context: 1_000_000 }),

  'claude-haiku-4-5': Object.freeze({ provider: 'anthropic', input: 1.00, output: 5.00, context: 200_000 }),
  'claude-sonnet-4-6': Object.freeze({ provider: 'anthropic', input: 3.00, output: 15.00, context: 200_000 }),
});

export const MODEL_ALIASES = Object.freeze({
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3-pro': 'gemini-3.1-pro-preview',
  // Backward compatibility: the retired/access-limited 2.5 id resolves to the
  // served replacement so an old env value or persisted request never 404s.
  'gemini-2.5-flash-lite': 'gemini-3.5-flash-lite',
  'gemini-2.5-flash': 'gemini-3-flash-preview',
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

// Ordered, curated fallback preference PER PROVIDER (best/cheapest first). The
// first entry is the provider default. This is what makes a within-provider
// fallback possible: when the requested model's family is the only configured
// provider, a failure on one model can fall through to a DIFFERENT model on the
// SAME provider instead of retrying the identical (broken) model — the second
// half of the MAESTRO_ALL_MODELS_FAILED root cause.
export const PROVIDER_MODEL_PREFERENCE = Object.freeze({
  openai: Object.freeze(['gpt-5-mini', 'gpt-5']),
  gemini: Object.freeze(['gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview']),
  anthropic: Object.freeze(['claude-haiku-4-5', 'claude-sonnet-4-6']),
});

// The model a provider falls back to when the caller asked for a model that
// belongs to a DIFFERENT (unconfigured) provider. Every entry is a real member
// of SUPPORTED_MODELS for that provider, so a remap can never produce a model
// the provider does not serve (the original cause of LLM_HTTP_404).
export const PROVIDER_DEFAULT_MODEL = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDER_MODEL_PREFERENCE).map(([provider, list]) => [provider, list[0]])
  )
);

/** Every supported model served by `provider`, in curated preference order. */
export function modelsForProvider(provider) {
  const curated = PROVIDER_MODEL_PREFERENCE[provider];
  const list = curated && curated.length
    ? [...curated]
    : Object.keys(SUPPORTED_MODELS).filter((id) => SUPPORTED_MODELS[id].provider === provider);
  // Only ever return models that really belong to the provider (hard invariant).
  return list.filter((id) => SUPPORTED_MODELS[id]?.provider === provider);
}

export function defaultModelForProvider(provider) {
  const candidate = PROVIDER_DEFAULT_MODEL[provider];
  return candidate && SUPPORTED_MODELS[candidate] ? candidate : 'gpt-5-mini';
}

// True only when `model` is a supported model served by `provider`. Used as a
// hard invariant before any request is dispatched to a provider.
export function isModelCompatible(model, provider) {
  try {
    return modelProvider(model) === provider;
  } catch {
    return false;
  }
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
