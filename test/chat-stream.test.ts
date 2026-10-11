import assert from 'node:assert/strict';
import test from 'node:test';
import { computeBackoff, consumeSse, defaultSleep, isAbortError, parseSseBuffer, streamWithReconnect } from '../src/services/api/sse';

// -----------------------------------------------------------------------------
// SSE wire parsing for chat streaming + run events.
//
// The chat UI consumes `POST /chat/stream` (SSE) instead of a single-shot
// completion, and the run timeline consumes `GET /runs/:id/events`. Both share
// the same parser (`src/services/api/sse.ts`), which is intentionally
// dependency-free so it can be unit-tested here without pulling in react-native.
// These tests pin the wire contract: frames split across chunks, multiple frames
// per chunk, malformed JSON dropped, and non-2xx responses surfaced as errors.
// -----------------------------------------------------------------------------

function sseResponse(frames: { event: string; data: unknown }[], { status = 200 } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

test('parseSseBuffer decodes start/token/done frames in order', () => {
  const buffer =
    'event: start\ndata: {"conversationId":"conv_1","assistantMessageId":"msg_a"}\n\n' +
    'event: token\ndata: {"text":"hel"}\n\n' +
    'event: token\ndata: {"text":"lo"}\n\n' +
    'event: done\ndata: {"usage":{"totalTokens":5}}\n\n';
  const { events, rest } = parseSseBuffer(buffer);
  assert.equal(rest, '');
  assert.deepEqual(events.map((event) => event.event), ['start', 'token', 'token', 'done']);
  assert.equal((events[0]?.data as { conversationId: string }).conversationId, 'conv_1');
  assert.equal(events.filter((event) => event.event === 'token').map((event) => (event.data as { text: string }).text).join(''), 'hello');
  assert.equal((events.at(-1)?.data as { usage: { totalTokens: number } }).usage.totalTokens, 5);
});

test('parseSseBuffer carries a partial trailing frame into the next read', () => {
  const first = parseSseBuffer('event: token\ndata: {"text":"par');
  assert.equal(first.events.length, 0);
  assert.equal(first.rest, 'event: token\ndata: {"text":"par');

  const second = parseSseBuffer(`${first.rest}tial"}\n\n`);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0]?.event, 'token');
  assert.equal((second.events[0]?.data as { text: string }).text, 'partial');
  assert.equal(second.rest, '');
});

test('parseSseBuffer drops malformed JSON frames without throwing', () => {
  const { events } = parseSseBuffer('event: token\ndata: {not json}\n\nevent: token\ndata: {"text":"ok"}\n\n');
  assert.equal(events.length, 1);
  assert.equal((events[0]?.data as { text: string }).text, 'ok');
});

test('parseSseBuffer defaults the event name when the frame omits it', () => {
  const { events } = parseSseBuffer('data: {"text":"bare"}\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, 'message');
});

test('consumeSse reads every frame from a live response body', async () => {
  const seen: { event: string; data: unknown }[] = [];
  await consumeSse(
    sseResponse([
      { event: 'start', data: { conversationId: 'conv_1' } },
      { event: 'token', data: { text: 'a' } },
      { event: 'token', data: { text: 'b' } },
      { event: 'done', data: {} },
    ]),
    (event) => seen.push(event),
  );
  assert.deepEqual(seen.map((event) => event.event), ['start', 'token', 'token', 'done']);
});

test('consumeSse surfaces a non-2xx response as BACKEND_SSE_<status>', async () => {
  await assert.rejects(
    () => consumeSse(new Response(JSON.stringify({ error: 'STREAMING_NOT_SUPPORTED' }), { status: 400, headers: { 'content-type': 'application/json' } }), () => {}),
    /BACKEND_SSE_400/,
  );
});

test('consumeSse rejects a response without a body', async () => {
  await assert.rejects(() => consumeSse(new Response(null, { status: 200 }), () => {}), /BACKEND_SSE_200/);
});

// -----------------------------------------------------------------------------
// id/retry parsing + comment (heartbeat) handling.
// -----------------------------------------------------------------------------

test('parseSseBuffer captures id and retry fields and ignores heartbeat comments', () => {
  const buffer =
    ': hb 12345\n\n' +
    'id: 7\nevent: token\ndata: {"text":"x"}\n\n' +
    'retry: 3000\nevent: token\ndata: {"text":"y"}\n\n';
  const { events } = parseSseBuffer(buffer);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.id, '7');
  assert.equal(events[0]?.event, 'token');
  assert.equal(events[1]?.retry, 3000);
  assert.equal(events[1]?.id, undefined);
});

test('parseSseBuffer joins multi-line data fields', () => {
  const { events } = parseSseBuffer('data: {"a":\ndata: 1}\n\n');
  assert.deepEqual(events[0]?.data, { a: 1 });
});

test('consumeSse returns the last event id seen', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}\n\n'));
      controller.close();
    },
  });
  const result = await consumeSse(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }), () => {});
  assert.equal(result.lastEventId, '2');
});

// -----------------------------------------------------------------------------
// Backoff + reconnect.
// -----------------------------------------------------------------------------

test('computeBackoff grows exponentially, is clamped, and jitters within bounds', () => {
  assert.equal(computeBackoff(1, { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0.5 }), 100);
  assert.equal(computeBackoff(2, { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0.5 }), 200);
  assert.equal(computeBackoff(3, { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0, random: () => 0.5 }), 400);
  assert.equal(computeBackoff(20, { baseDelayMs: 100, maxDelayMs: 1_000, jitterRatio: 0, random: () => 0.5 }), 1_000);
  assert.equal(computeBackoff(1, { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0.2, random: () => 1 }), 120);
  assert.equal(computeBackoff(1, { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0.2, random: () => 0 }), 80);
});

test('isAbortError only matches an AbortError', () => {
  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbortError(new Error('x')), false);
  assert.equal(isAbortError(null), false);
});

test('defaultSleep resolves early when the signal aborts', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = defaultSleep(5_000, controller.signal);
  controller.abort();
  await pending;
  assert.ok(Date.now() - started < 1_000, 'an aborted sleep must not wait the full delay');
});

function rawSseResponse(text: string, { status = 200 } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** A stream that delivers `text` then errors, simulating a mid-stream drop. */
function droppingSseResponse(text: string): Response {
  const encoder = new TextEncoder();
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) { controller.enqueue(encoder.encode(text)); return; }
      controller.error(new Error('network drop'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('streamWithReconnect resumes from the last event id after a drop', async () => {
  const attempts: (string | null)[] = [];
  const seen: string[] = [];
  const result = await streamWithReconnect({
    maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 4, random: () => 0.5, sleep: async () => {},
    connect: async (lastEventId) => {
      attempts.push(lastEventId);
      if (attempts.length === 1) return droppingSseResponse('id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}\n\n');
      return rawSseResponse('id: 3\ndata: {"n":3}\n\nevent: close\ndata: {"status":"completed"}\n\n');
    },
    isTerminal: (event) => event.event === 'close',
    onEvent: (event) => seen.push(event.event),
  });
  assert.deepEqual(attempts, [null, '2'], 'the reconnect must resume from the last seen id');
  assert.equal(result.terminal, true);
  assert.equal(result.reconnects, 1);
  assert.equal(result.lastEventId, '3');
  assert.deepEqual(seen, ['message', 'message', 'message', 'close']);
});

test('streamWithReconnect stops at a terminal frame without reconnecting', async () => {
  let connects = 0;
  const result = await streamWithReconnect({
    sleep: async () => {},
    connect: async () => { connects += 1; return rawSseResponse('event: close\ndata: {"status":"completed"}\n\n'); },
    isTerminal: (event) => event.event === 'close',
    onEvent: () => {},
  });
  assert.equal(connects, 1);
  assert.equal(result.terminal, true);
  assert.equal(result.reconnects, 0);
});

test('streamWithReconnect reconnects when the server closes without a terminal frame', async () => {
  const attempts: (string | null)[] = [];
  const result = await streamWithReconnect({
    maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2, random: () => 0.5, sleep: async () => {},
    connect: async (lastEventId) => {
      attempts.push(lastEventId);
      if (attempts.length === 1) return rawSseResponse('id: 1\ndata: {"n":1}\n\n');
      return rawSseResponse('event: close\ndata: {"status":"completed"}\n\n');
    },
    isTerminal: (event) => event.event === 'close',
    onEvent: () => {},
  });
  assert.deepEqual(attempts, [null, '1']);
  assert.equal(result.terminal, true);
});

test('streamWithReconnect gives up after maxAttempts and rethrows the last error', async () => {
  let connects = 0;
  await assert.rejects(
    () => streamWithReconnect({
      maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, random: () => 0.5, sleep: async () => {},
      connect: async () => { connects += 1; return droppingSseResponse('id: 1\ndata: {"n":1}\n\n'); },
      onEvent: () => {},
    }),
    /network drop/,
  );
  assert.equal(connects, 4, 'one initial attempt plus maxAttempts reconnects');
});

test('streamWithReconnect stops immediately when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let connects = 0;
  const result = await streamWithReconnect({
    signal: controller.signal,
    connect: async () => { connects += 1; return rawSseResponse('id: 1\ndata: {}\n\n'); },
    onEvent: () => {},
  });
  assert.equal(connects, 0);
  assert.equal(result.terminal, false);
});
