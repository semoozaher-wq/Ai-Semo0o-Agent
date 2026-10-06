import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { createLLMRouter } from '../llm/providers.mjs';

// -----------------------------------------------------------------------------
// Streaming regression suite.
//
// `POST /chat/stream` consumes `llm.stream(...)`, which previously did not exist
// on the router, so the endpoint always answered `STREAMING_NOT_SUPPORTED` and
// was effectively dead code. These tests pin the streaming contract:
//   * each provider's native SSE wire format is normalised to token/done frames;
//   * the router never streams a model to a provider that does not serve it;
//   * when the runtime cannot expose a readable body, it degrades gracefully to a
//     single-shot completion instead of failing;
//   * the real HTTP endpoint emits a valid `text/event-stream` response.
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
    return handler(record, calls.length);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    body,
    async text() {
      return chunks.join('');
    },
  };
}

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    async text() {
      return JSON.stringify(payload);
    },
  };
}

async function collect(iterator) {
  const frames = [];
  for await (const frame of iterator) frames.push(frame);
  return frames;
}

test('stream(): no provider configured fails closed with a clear diagnostic', async () => {
  const router = createLLMRouter({});
  await assert.rejects(
    () => collect(router.stream({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] })),
    (error) => {
      assert.equal(error.code, 'NO_SERVER_LLM_PROVIDER_CONFIGURED');
      return true;
    }
  );
});

test('stream(): OpenAI SSE frames are normalised to token + done frames', async () => {
  const stub = withFetch(() =>
    sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ])
  );

  try {
    const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test' });
    const frames = await collect(router.stream({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }));

    const tokens = frames.filter((frame) => frame.type === 'token').map((frame) => frame.text).join('');
    assert.equal(tokens, 'Hello');

    const done = frames.find((frame) => frame.type === 'done');
    assert.ok(done, 'a terminal done frame is required');
    assert.equal(done.text, 'Hello');
    assert.equal(done.provider, 'openai');
    assert.equal(done.usage.totalTokens, 3);
    assert.equal(done.substituted, false);
    assert.equal(done.model, 'gpt-5');

    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].body.stream, true, 'the provider request must opt into streaming');
    assert.match(stub.calls[0].url, /api\.openai\.com\/v1\/chat\/completions/);
  } finally {
    stub.restore();
  }
});

test('stream(): Gemini SSE frames are normalised to token + done frames', async () => {
  const stub = withFetch(() =>
    sseResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"مرحبا"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":" بالعالم"}]}}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}\n\n',
    ])
  );

  try {
    const router = createLLMRouter({ GEMINI_API_KEY: 'g-test' });
    const frames = await collect(router.stream({ model: 'gemini-2.5-flash-lite', messages: [{ role: 'user', content: 'hi' }] }));

    const tokens = frames.filter((frame) => frame.type === 'token').map((frame) => frame.text).join('');
    assert.equal(tokens, 'مرحبا بالعالم');

    const done = frames.find((frame) => frame.type === 'done');
    assert.equal(done.provider, 'gemini');
    assert.equal(done.usage.totalTokens, 5);
    assert.match(stub.calls[0].url, /:streamGenerateContent\?alt=sse/);
  } finally {
    stub.restore();
  }
});

test('stream(): Anthropic SSE frames are normalised to token + done frames', async () => {
  const stub = withFetch(() =>
    sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Bon"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"jour"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":6}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])
  );

  try {
    const router = createLLMRouter({ ANTHROPIC_API_KEY: 'a-test' });
    const frames = await collect(router.stream({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] }));

    const tokens = frames.filter((frame) => frame.type === 'token').map((frame) => frame.text).join('');
    assert.equal(tokens, 'Bonjour');

    const done = frames.find((frame) => frame.type === 'done');
    assert.equal(done.provider, 'anthropic');
    assert.equal(done.usage.promptTokens, 4);
    assert.equal(done.usage.completionTokens, 6);
    assert.equal(stub.calls[0].body.stream, true);
    assert.match(stub.calls[0].url, /api\.anthropic\.com\/v1\/messages/);
  } finally {
    stub.restore();
  }
});

test('stream(): an OpenAI model is remapped to a compatible provider, never streamed cross-family', async () => {
  const stub = withFetch(() =>
    sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n'])
  );

  try {
    const router = createLLMRouter({ GEMINI_API_KEY: 'g-test' });
    const frames = await collect(router.stream({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }));

    const done = frames.find((frame) => frame.type === 'done');
    assert.equal(done.provider, 'gemini');
    assert.equal(done.substituted, true);
    assert.equal(done.requestedModel, 'gpt-5');
    assert.notEqual(done.model, 'gpt-5');
    assert.match(stub.calls[0].url, /generativelanguage\.googleapis\.com/);
  } finally {
    stub.restore();
  }
});

test('stream(): falls back to a buffered completion when the runtime cannot stream', async () => {
  const stub = withFetch((record, callIndex) => {
    // First attempt: the streaming response has no readable body.
    if (callIndex === 1) {
      return { ok: true, status: 200, body: null, async text() { return ''; } };
    }
    // Fallback: a normal buffered JSON completion.
    return jsonResponse({
      choices: [{ message: { content: 'buffered answer' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });

  try {
    const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test' });
    const frames = await collect(router.stream({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }));

    const tokens = frames.filter((frame) => frame.type === 'token').map((frame) => frame.text).join('');
    assert.equal(tokens, 'buffered answer');

    const done = frames.find((frame) => frame.type === 'done');
    assert.equal(done.text, 'buffered answer');
    assert.equal(done.provider, 'openai');
    assert.equal(stub.calls.length, 2, 'one streaming attempt + one buffered fallback');
  } finally {
    stub.restore();
  }
});

// -----------------------------------------------------------------------------
// Real-HTTP end-to-end test: the endpoint must emit a valid SSE response.
// -----------------------------------------------------------------------------

function startMockOpenAIStream() {
  const state = { calls: 0, models: [], streamFlags: [] };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      state.calls += 1;
      state.models.push(body.model);
      state.streamFlags.push(body.stream === true);

      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write('data: {"choices":[{"delta":{"content":"مرحبا "}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"بالعالم"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n');
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

test('POST /chat/stream streams SSE token frames and a done frame over real HTTP', async () => {
  const mock = await startMockOpenAIStream();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-stream-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const llm = createLLMRouter({ OPENAI_API_KEY: 'sk-stream-test', OPENAI_API_BASE: mock.baseUrl });
  const tools = createLiveToolRegistry({ db, llm, getWorkspaceRoot: () => dir });
  const app = createApp({ db, queue, llm, liveTools: tools });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  try {
    const registered = await fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'stream@example.test', password: 'correct horse battery staple', tenantName: 'Stream' }),
    });
    assert.equal(registered.status, 201);
    const { session } = await registered.json();

    const response = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ message: 'مرحبا', model: 'gpt-5' }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const text = await response.text();
    assert.match(text, /event: token/);
    assert.match(text, /مرحبا/);
    assert.match(text, /بالعالم/);
    assert.match(text, /event: done/);
    assert.doesNotMatch(text, /STREAMING_NOT_SUPPORTED/);

    assert.equal(mock.state.streamFlags[0], true, 'the endpoint must request a real provider stream');
    assert.equal(mock.state.models[0], 'gpt-5');
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
