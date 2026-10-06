import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeSse, parseSseBuffer } from '../src/services/api/sse';

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
