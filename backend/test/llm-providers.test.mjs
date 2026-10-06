import assert from 'node:assert/strict';
import test from 'node:test';
import { createLLMRouter } from '../llm/providers.mjs';
import {
  SUPPORTED_MODELS,
  modelProvider,
  defaultModelForProvider,
  isModelCompatible,
} from '../models/catalog.mjs';

// -----------------------------------------------------------------------------
// Regression suite for the `LLM_HTTP_404` incident.
//
// Symptom: every agent run failed with `LLM_HTTP_404` (attempts: 3) and planning
// never started. Root cause: the router selected a provider by model FAMILY but
// then sent the requested model ID VERBATIM to whichever provider was configured
// first. With only a Gemini key configured, the UI default model `gpt-5`
// (OpenAI family) was POSTed to the Gemini endpoint, which answered 404
// (model not found).
//
// These tests assert the invariant that fixes it: a model is only ever sent to a
// provider that serves its family, unconfigured families are transparently
// remapped to a compatible model, and a genuine 404 surfaces a clear diagnostic
// (LLM_MODEL_NOT_FOUND) instead of the opaque LLM_HTTP_404.
// -----------------------------------------------------------------------------

function withFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const record = {
      url: String(url),
      method: init?.method,
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : null,
    };
    calls.push(record);
    return handler(record);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function ok(payload) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function fail(status, payload = {}) {
  return {
    ok: false,
    status,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function geminiModelFromUrl(url) {
  return decodeURIComponent(url.match(/models\/([^:]+):/)[1]);
}

test('no provider configured fails closed with a clear diagnostic (never LLM_HTTP_404)', async () => {
  const router = createLLMRouter({});
  await assert.rejects(
    () => router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.equal(error.code, 'NO_SERVER_LLM_PROVIDER_CONFIGURED');
      assert.match(error.message, /NO_SERVER_LLM_PROVIDER_CONFIGURED/);
      assert.match(error.message, /OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY/);
      assert.doesNotMatch(error.message, /LLM_HTTP_404/);
      return true;
    }
  );
});

test('regression: OpenAI model with only Gemini configured is remapped to a Gemini model (no LLM_HTTP_404)', async () => {
  const stub = withFetch(() =>
    ok({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })
  );
  try {
    const router = createLLMRouter({ GEMINI_API_KEY: 'g-test' });
    const result = await router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(stub.calls.length, 1, 'exactly one provider call');
    const call = stub.calls[0];
    assert.match(call.url, /generativelanguage\.googleapis\.com\/v1beta\/models\//);

    const sentModel = geminiModelFromUrl(call.url);
    assert.notEqual(sentModel, 'gpt-5', 'the OpenAI model must NEVER be sent to Gemini');
    assert.ok(sentModel.startsWith('gemini-'), `expected a Gemini model, got ${sentModel}`);

    assert.equal(result.provider, 'gemini');
    assert.equal(result.substituted, true);
    assert.equal(result.requestedModel, 'gpt-5');
    assert.equal(result.model, sentModel);
  } finally {
    stub.restore();
  }
});

test('regression: OpenAI model with only Anthropic configured is remapped to a Claude model', async () => {
  const stub = withFetch(() => ok({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  try {
    const router = createLLMRouter({ ANTHROPIC_API_KEY: 'a-test' });
    const result = await router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

    const call = stub.calls[0];
    assert.match(call.url, /api\.anthropic\.com\/v1\/messages/);
    assert.notEqual(call.body.model, 'gpt-5', 'the OpenAI model must NEVER be sent to Anthropic');
    assert.ok(call.body.model.startsWith('claude-'), `expected a Claude model, got ${call.body.model}`);

    assert.equal(result.provider, 'anthropic');
    assert.equal(result.substituted, true);
  } finally {
    stub.restore();
  }
});

test('the requested model is sent verbatim when its own provider is configured', async () => {
  const stub = withFetch(() => ok({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  try {
    const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test' });
    const result = await router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

    const call = stub.calls[0];
    assert.match(call.url, /api\.openai\.com\/v1\/chat\/completions/);
    assert.equal(call.body.model, 'gpt-5');
    assert.equal(result.provider, 'openai');
    assert.equal(result.substituted, false);
    assert.equal(result.model, 'gpt-5');
  } finally {
    stub.restore();
  }
});

test('a Gemini model is sent verbatim to Gemini when GEMINI_API_KEY is configured', async () => {
  const stub = withFetch(() => ok({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  try {
    const router = createLLMRouter({ GEMINI_API_KEY: 'g-test' });
    const result = await router.complete({ model: 'gemini-3.1-pro-preview', messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(geminiModelFromUrl(stub.calls[0].url), 'gemini-3.1-pro-preview');
    assert.equal(result.substituted, false);
    assert.equal(result.provider, 'gemini');
  } finally {
    stub.restore();
  }
});

test('a 404 from a configured provider surfaces LLM_MODEL_NOT_FOUND, never opaque LLM_HTTP_404', async () => {
  const stub = withFetch(() => fail(404, { error: { message: 'model not found' } }));
  try {
    const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test' });
    await assert.rejects(
      () => router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
      (error) => {
        assert.equal(error.code, 'LLM_MODEL_NOT_FOUND');
        assert.equal(error.status, 404);
        assert.equal(error.provider, 'openai');
        assert.equal(error.model, 'gpt-5');
        assert.match(error.endpoint, /chat\/completions/);
        assert.ok(error.hint && error.hint.length > 0, 'a remediation hint is required');
        assert.doesNotMatch(error.message, /LLM_HTTP_404/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

test('a configured GEMINI_MODEL is honored when remapping an OpenAI model to Gemini', async () => {
  const stub = withFetch(() => ok({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  try {
    const router = createLLMRouter({ GEMINI_API_KEY: 'g-test', GEMINI_MODEL: 'gemini-3-flash-preview' });
    const result = await router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(geminiModelFromUrl(stub.calls[0].url), 'gemini-3-flash-preview');
    assert.equal(result.model, 'gemini-3-flash-preview');
    assert.equal(result.substituted, true);
  } finally {
    stub.restore();
  }
});

test('status() reports the configured providers', () => {
  const router = createLLMRouter({ GEMINI_API_KEY: 'g-test', ANTHROPIC_API_KEY: 'a-test' });
  const ids = router.status().map((provider) => provider.id).sort();
  assert.deepEqual(ids, ['anthropic', 'gemini']);
});

test('catalog invariant: every supported model is compatible with its provider and its fallback', () => {
  for (const [model, spec] of Object.entries(SUPPORTED_MODELS)) {
    assert.equal(modelProvider(model), spec.provider);
    assert.ok(isModelCompatible(model, spec.provider), `${model} must be compatible with ${spec.provider}`);
    const fallback = defaultModelForProvider(spec.provider);
    assert.ok(isModelCompatible(fallback, spec.provider), `${fallback} must be compatible with ${spec.provider}`);
  }
});

test('an unsupported model id is rejected before any provider call', async () => {
  const stub = withFetch(() => ok({}));
  try {
    const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test' });
    await assert.rejects(
      () => router.complete({ model: 'not-a-real-model', messages: [] }),
      /UNSUPPORTED_MODEL/
    );
    assert.equal(stub.calls.length, 0, 'no network call for an unsupported model');
  } finally {
    stub.restore();
  }
});
