import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createSseChannel, parseResumeCursor, logSse } from '../sse/stream.mjs';

// -----------------------------------------------------------------------------
// SSE auto-recovery + monitoring.
//
// The run/creation/chat streams were fragile: a reconnecting client restarted
// from sequence 0, idle sockets were reaped by proxies, and a dropped stream
// left no trace. These tests pin the fixes:
//   * `parseResumeCursor` honours `Last-Event-ID` (then `?since=`);
//   * `createSseChannel` writes id-numbered frames, comment heartbeats, is safe
//     after a client disconnect, and logs the lifecycle;
//   * the real `GET /runs/:id/events` endpoint resumes from `Last-Event-ID`;
//   * `POST /chat/stream` numbers its frames.
// -----------------------------------------------------------------------------

function fakeResponse() {
  const chunks = [];
  return {
    writableEnded: false,
    destroyed: false,
    write(chunk) { chunks.push(chunk); return true; },
    end() { this.writableEnded = true; },
    text() { return chunks.join(''); },
  };
}

function fakeRequest(headers = {}, url = '/') {
  const listeners = new Map();
  return {
    headers,
    url,
    on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
    off(event, fn) { listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== fn)); },
    emit(event) { for (const fn of listeners.get(event) ?? []) fn(); },
  };
}

// --- parseResumeCursor -------------------------------------------------------

test('parseResumeCursor prefers the Last-Event-ID header over ?since=', () => {
  assert.equal(parseResumeCursor({ headers: { 'last-event-id': '7' }, url: '/runs/x/events?since=3' }), 7);
});

test('parseResumeCursor falls back to the ?since= query parameter', () => {
  assert.equal(parseResumeCursor({ headers: {}, url: '/runs/x/events?since=5' }), 5);
});

test('parseResumeCursor accepts an array header and rejects invalid values', () => {
  assert.equal(parseResumeCursor({ headers: { 'last-event-id': ['4'] }, url: '/' }), 4);
  assert.equal(parseResumeCursor({ headers: { 'last-event-id': 'abc' }, url: '/?since=x' }, 0), 0);
});

test('parseResumeCursor returns the fallback when nothing is present', () => {
  assert.equal(parseResumeCursor({ headers: {}, url: '/runs/x/events' }, 2), 2);
  assert.equal(parseResumeCursor({}, 9), 9);
  assert.equal(parseResumeCursor(undefined, 1), 1);
});

// --- createSseChannel --------------------------------------------------------

test('createSseChannel writes id/event/data frames and counts them', () => {
  const response = fakeResponse();
  const channel = createSseChannel(response, { heartbeatMs: 0 });
  channel.write({ id: 3, event: 'token', data: { text: 'hi' } });
  channel.write({ data: '{"raw":true}' });
  assert.equal(response.text(), 'id: 3\nevent: token\ndata: {"text":"hi"}\n\ndata: {"raw":true}\n\n');
  assert.equal(channel.frames, 2);
});

test('createSseChannel heartbeats are comments and increment the counter', () => {
  const response = fakeResponse();
  const channel = createSseChannel(response, { heartbeatMs: 0 });
  assert.equal(channel.heartbeat(), true);
  assert.equal(channel.heartbeats, 1);
  assert.match(response.text(), /^: hb \d+/);
});

test('createSseChannel.end writes a close frame with the status and ends the response', () => {
  const response = fakeResponse();
  const channel = createSseChannel(response, { heartbeatMs: 0 });
  channel.end('completed');
  assert.equal(response.text(), 'event: close\ndata: {"status":"completed"}\n\n');
  assert.equal(response.writableEnded, true);
  assert.equal(channel.closed, true);
});

test('createSseChannel stops writing once the client has disconnected', () => {
  const response = fakeResponse();
  const request = fakeRequest();
  const channel = createSseChannel(response, { request, heartbeatMs: 0 });
  channel.write({ id: 1, data: { n: 1 } });
  request.emit('close');
  assert.equal(channel.closed, true);
  assert.equal(channel.write({ id: 2, data: { n: 2 } }), false);
  assert.equal(channel.heartbeat(), false);
  assert.equal(response.text(), 'id: 1\ndata: {"n":1}\n\n');
});

test('createSseChannel.startHeartbeat emits periodic comments until stopped', async () => {
  const response = fakeResponse();
  const channel = createSseChannel(response, { heartbeatMs: 5 });
  channel.startHeartbeat();
  await new Promise((resolve) => setTimeout(resolve, 30));
  channel.stopHeartbeat();
  assert.ok(channel.heartbeats >= 1, 'at least one heartbeat must have been emitted');
});

test('logSse writes one structured JSON line and never throws', () => {
  const lines = [];
  logSse({ info: (line) => lines.push(line) }, 'info', 'sse.open', { runId: 'r1' });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, 'sse.open');
  assert.equal(parsed.runId, 'r1');
  assert.equal(parsed.level, 'info');
  assert.ok(parsed.at);
  assert.doesNotThrow(() => logSse({ info: () => { throw new Error('boom'); } }, 'info', 'x', {}));
});

// --- HTTP-level: run events resume + chat frame ids --------------------------

function mockLlm() {
  return {
    status: () => [{ id: 'test', model: 'test', configured: true }],
    async complete() { return { provider: 'test', text: 'hello world', usage: { totalTokens: 5 } }; },
    async *stream() {
      yield { type: 'token', text: 'hel' };
      yield { type: 'token', text: 'lo' };
      yield { type: 'done', usage: { totalTokens: 5 }, provider: 'test' };
    },
  };
}

async function fixture({ llm = mockLlm() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-sse-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    return { status: response.status, contentType, body: contentType.includes('json') ? await response.json().catch(() => ({})) : await response.text() };
  };
  const register = async (email) => {
    const response = await request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: email } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { token: response.body.session.token, tenantId: response.body.user.tenantId, userId: response.body.user.id };
  };
  return {
    dir, db, queue, app, base, request, register,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('GET /runs/:id/events resumes from the Last-Event-ID header', async () => {
  const fx = await fixture();
  try {
    const { token, tenantId } = await fx.register('sse@run.test');
    const project = await fx.request('/projects', { method: 'POST', token, body: { name: 'P', rootPath: fx.dir } });
    const created = await fx.request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'g', model: 'test' } });
    const runId = created.body.runId;
    // Seed three events; the run stays non-terminal because the worker is not started.
    for (let i = 1; i <= 3; i += 1) {
      fx.db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', `evt_${i}`, runId, tenantId, 'step', JSON.stringify({ n: i }), new Date(Date.now() + i).toISOString());
    }
    const controller = new AbortController();
    const response = await fetch(`${fx.base}/runs/${runId}/events`, { headers: { authorization: `Bearer ${token}`, 'last-event-id': '2' }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !text.includes('"n":3')) {
      const next = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve({ done: true }), 250))]);
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    controller.abort();
    assert.match(text, /id: 3/);
    assert.match(text, /"n":3/);
    assert.doesNotMatch(text, /id: 1\n/);
    assert.doesNotMatch(text, /id: 2\n/);
  } finally { await fx.close(); }
});

test('POST /chat/stream numbers its frames with id:', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('sse@chat.test');
    const response = await fetch(`${fx.base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: 'hi' }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /id: 1\nevent: start/);
    assert.match(text, /event: token/);
    assert.match(text, /event: done/);
  } finally { await fx.close(); }
});
