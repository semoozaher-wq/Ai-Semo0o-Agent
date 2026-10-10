import assert from 'node:assert/strict';
import test from 'node:test';
import { createLLMRouter } from '../llm/providers.mjs';
import { MaestroModelRouter } from '../models/task-router.mjs';

// -----------------------------------------------------------------------------
// Regression suite for the `MAESTRO_ALL_MODELS_FAILED` incident.
//
// Root cause (see backend/models/catalog.mjs + backend/llm/providers.mjs):
//   1. The configured provider's DEFAULT model (`gemini-2.5-flash-lite`) was
//      access-limited, so a fresh key got 404/429 for it.
//   2. The fallback path COLLAPSED: every cross-family candidate was remapped to
//      the SAME single (provider, default-model) pair, so a broken default was
//      retried N times instead of falling through to another model/provider.
//   3. A 429 ignored `Retry-After` and could not fail over to a valid provider.
//
// These tests pin the FIXED behaviour:
//   * 429  -> Retry-After is honoured (bounded) and the call is retried.
//   * 404  -> an unavailable model falls through to a DIFFERENT model on the
//             SAME provider (never a repeated retry of the broken model).
//   * all  -> when every alternative fails, the terminal error carries a
//             structured per-model/per-provider `attempts` list.
//   * 429  -> a quota-exhausted provider fails over to a DIFFERENT provider and
//             the run still completes.
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
    return handler(record, calls.length - 1);
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
    headers: { get: () => null },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function fail(status, payload = {}, headers = {}) {
  const lowered = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    ok: false,
    status,
    headers: { get: (name) => lowered[String(name).toLowerCase()] ?? null },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function geminiModelFromUrl(url) {
  return decodeURIComponent(url.match(/models\/([^:]+):/)[1]);
}

const openaiOk = () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const geminiOk = () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } });

const isOpenAi = (url) => url.includes('api.openai.com');
const isGemini = (url) => url.includes('generativelanguage.googleapis.com');

/** Run `fn` with LLM retry env overrides, restoring them afterwards. */
async function withRetryEnv(overrides, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('429: a Retry-After header is honoured (bounded wait) and the call retries', async () => {
  await withRetryEnv({ LLM_RETRY_BASE_MS: 2000, LLM_MAX_RETRY_DELAY_MS: 2000 }, async () => {
    let calls = 0;
    const stub = withFetch(() => {
      calls += 1;
      if (calls === 1) return fail(429, { error: { message: 'rate limited' } }, { 'retry-after': '0' });
      return ok(openaiOk());
    });
    try {
      const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test' });
      const started = Date.now();
      const result = await router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });
      const elapsed = Date.now() - started;

      assert.equal(result.provider, 'openai');
      assert.equal(result.model, 'gpt-5');
      assert.equal(calls, 2, 'the 429 must be retried once the Retry-After elapses');
      assert.ok(elapsed < 1500, `Retry-After:0 must override the 2000ms backoff (waited ${elapsed}ms)`);
    } finally {
      stub.restore();
    }
  });
});

test('429: a persistently rate-limited provider fails over to a different provider and completes', async () => {
  await withRetryEnv({ LLM_RETRY_BASE_MS: 0, LLM_MAX_RETRY_DELAY_MS: 0 }, async () => {
    const stub = withFetch((record) => {
      if (isOpenAi(record.url)) return fail(429, { error: { message: 'quota exceeded' } }, { 'retry-after': '0' });
      return ok(geminiOk());
    });
    try {
      const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test' });
      const routed = new MaestroModelRouter().createRoutedLLM({ llm: router, taskType: 'reasoning' });

      const result = await routed.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

      assert.equal(result.routedProvider, 'gemini', 'a 429 on OpenAI must fail over to Gemini');
      assert.ok(String(result.routedModel).startsWith('gemini-'), `expected a Gemini model, got ${result.routedModel}`);
      assert.ok(stub.calls.some((call) => isOpenAi(call.url)), 'OpenAI must have been attempted first');
      assert.ok(stub.calls.some((call) => isGemini(call.url)), 'Gemini must have been used as the fallback');
    } finally {
      stub.restore();
    }
  });
});

test('unavailable model (404) falls through to a DIFFERENT model on the SAME provider', async () => {
  const stub = withFetch((record) => {
    if (record.body.model === 'gpt-5') return fail(404, { error: { message: 'model not found' } });
    return ok(openaiOk());
  });
  try {
    const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test' });
    const result = await router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(stub.calls.length, 2, 'the broken model must be retried on a DIFFERENT model, not the same one');
    assert.equal(stub.calls[0].body.model, 'gpt-5', 'the requested model is tried first');
    assert.equal(stub.calls[1].body.model, 'gpt-5-mini', 'the fallback is a different model on the same provider');
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-5-mini');
    assert.equal(result.requestedModel, 'gpt-5');
    assert.equal(result.substituted, true);
  } finally {
    stub.restore();
  }
});

test('all alternatives failed: the terminal error carries a structured per-model attempts list', async () => {
  const stub = withFetch(() => fail(404, { error: { message: 'model not found' } }));
  try {
    const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test' });
    await assert.rejects(
      () => router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
      (error) => {
        assert.equal(error.code, 'LLM_MODEL_NOT_FOUND');
        assert.ok(Array.isArray(error.attempts), 'the error must carry an attempts list');
        assert.ok(error.attempts.length >= 2, 'every candidate model must be recorded');
        const models = error.attempts.map((attempt) => attempt.model);
        assert.ok(models.includes('gpt-5') && models.includes('gpt-5-mini'), `expected both OpenAI models, got ${models.join(',')}`);
        for (const attempt of error.attempts) {
          assert.equal(attempt.provider, 'openai');
          assert.equal(attempt.ok, false);
          assert.equal(attempt.status, 404);
          assert.equal(attempt.code, 'LLM_MODEL_NOT_FOUND');
          assert.ok(typeof attempt.error === 'string' && attempt.error.length > 0);
        }
        assert.ok(typeof error.summary === 'string' && error.summary.length > 0, 'a human-readable summary is required');
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

test('all alternatives failed: MAESTRO_ALL_MODELS_FAILED carries the flattened dispatch attempts', async () => {
  await withRetryEnv({ LLM_RETRY_BASE_MS: 0, LLM_MAX_RETRY_DELAY_MS: 0 }, async () => {
    const stub = withFetch(() => fail(429, { error: { message: 'quota exceeded' } }, { 'retry-after': '0' }));
    try {
      const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test' });
      const routed = new MaestroModelRouter().createRoutedLLM({ llm: router, taskType: 'reasoning' });

      await assert.rejects(
        () => routed.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
        (error) => {
          assert.equal(error.code, 'MAESTRO_ALL_MODELS_FAILED');
          assert.equal(error.failureKind, 'MODEL_ROUTING_FAILURE');
          assert.ok(Array.isArray(error.attempts) && error.attempts.length >= 1);
          const providers = new Set(error.attempts.map((attempt) => attempt.provider));
          assert.ok(providers.has('openai'), 'the OpenAI attempts must be recorded');
          for (const attempt of error.attempts) {
            assert.equal(attempt.ok, false);
            assert.equal(attempt.status, 429);
            assert.equal(attempt.retryable, true, 'a 429 is recoverable and must be flagged as such');
          }
          assert.match(error.summary, /failed/);
          return true;
        }
      );
    } finally {
      stub.restore();
    }
  });
});

test('cross-provider failover: a Gemini-key-only deployment serves an OpenAI request via a Gemini model', async () => {
  const stub = withFetch(() => ok(geminiOk()));
  try {
    const router = createLLMRouter({ GEMINI_API_KEY: 'g-test' });
    const result = await router.complete({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(stub.calls.length, 1, 'the remapped call must succeed on the first attempt');
    const sent = geminiModelFromUrl(stub.calls[0].url);
    assert.notEqual(sent, 'gpt-5', 'the OpenAI model must NEVER be sent to Gemini');
    assert.equal(result.provider, 'gemini');
    assert.equal(result.requestedModel, 'gpt-5');
    assert.equal(result.substituted, true);
  } finally {
    stub.restore();
  }
});
