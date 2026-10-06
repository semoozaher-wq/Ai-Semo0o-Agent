import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { ChatStore } from '../chat/store.mjs';

function mockLlm() {
  return {
    status: () => [{ id: 'test', model: 'test', configured: true }],
    async complete() { return { provider: 'test', text: 'hello world', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }; },
    async *stream() {
      yield { type: 'token', text: 'hel' };
      yield { type: 'token', text: 'lo world' };
      yield { type: 'done', usage: { totalTokens: 5 }, provider: 'test' };
    },
  };
}

async function fixture({ llm = mockLlm() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-chat-'));
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

test('conversations support full CRUD through the HTTP API', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('crud@chat.test');

    const created = await fx.request('/conversations', { method: 'POST', token, body: { title: 'First thread' } });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.equal(created.body.title, 'First thread');
    assert.equal(created.body.status, 'active');
    assert.deepEqual(created.body.messages, []);

    const listed = await fx.request('/conversations', { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.conversations.length, 1);
    assert.equal(listed.body.conversations[0].id, id);

    // Append a user message, then read it back.
    const appended = await fx.request(`/conversations/${id}/messages`, { method: 'POST', token, body: { content: 'hi there' } });
    assert.equal(appended.status, 201);
    assert.equal(appended.body.role, 'user');
    const fetched = await fx.request(`/conversations/${id}`, { token });
    assert.equal(fetched.body.messages.length, 1);
    assert.equal(fetched.body.messages[0].content, 'hi there');

    const renamed = await fx.request(`/conversations/${id}`, { method: 'PATCH', token, body: { title: 'Renamed' } });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.title, 'Renamed');

    const deleted = await fx.request(`/conversations/${id}`, { method: 'DELETE', token });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    assert.equal(deleted.body.messages, 1);
    assert.equal((await fx.request(`/conversations/${id}`, { token })).status, 404);
  } finally { await fx.close(); }
});

test('POST /chat persists the conversation, user turn, and assistant turn', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('chat@chat.test');
    const response = await fx.request('/chat', { method: 'POST', token, body: { message: 'مرحبا' } });
    assert.equal(response.status, 200);
    assert.equal(response.body.text, 'hello world');
    assert.ok(response.body.conversationId);
    assert.ok(response.body.messageId);

    const conversation = await fx.request(`/conversations/${response.body.conversationId}`, { token });
    assert.equal(conversation.status, 200);
    const [user, assistant] = conversation.body.messages;
    assert.equal(user.role, 'user');
    assert.equal(user.content, 'مرحبا');
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content, 'hello world');
    assert.equal(assistant.status, 'complete');
    assert.equal(assistant.provider, 'test');
    assert.equal(assistant.usage.totalTokens, 5);

    // A follow-up reuses the same conversation.
    const followUp = await fx.request('/chat', { method: 'POST', token, body: { message: 'again', conversationId: response.body.conversationId } });
    assert.equal(followUp.body.conversationId, response.body.conversationId);
    const after = await fx.request(`/conversations/${response.body.conversationId}`, { token });
    assert.equal(after.body.messages.length, 4);
  } finally { await fx.close(); }
});

test('POST /chat/stream persists a completed assistant turn and emits start/done frames', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('stream@chat.test');
    const response = await fetch(`${fx.base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: 'stream please' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: start/);
    assert.match(text, /event: token/);
    assert.match(text, /event: done/);

    // The start frame carries the ids the client needs to reconcile state.
    const startLine = text.split('\n').find((line) => line.startsWith('data:') && line.includes('assistantMessageId'));
    const startData = JSON.parse(startLine.slice('data:'.length).trim());
    assert.ok(startData.conversationId);
    assert.ok(startData.assistantMessageId);

    const conversation = await fx.request(`/conversations/${startData.conversationId}`, { token });
    const assistant = conversation.body.messages.find((m) => m.id === startData.assistantMessageId);
    assert.equal(assistant.status, 'complete');
    assert.equal(assistant.content, 'hello world');
  } finally { await fx.close(); }
});

test('an interrupted stream is recoverable and can be swept to `interrupted`', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('recover@chat.test');
    const created = await fx.request('/conversations', { method: 'POST', token, body: { title: 'Crashy' } });
    const conversationId = created.body.id;

    // Simulate a process that died mid-stream: an assistant row stuck `streaming`.
    const stuck = fx.app.chat.appendMessage({ tenantId: created.body.tenantId ?? (await fx.db.get('SELECT tenant_id FROM conversations WHERE id=?', conversationId)).tenant_id, conversationId, role: 'assistant', content: 'partial', status: 'streaming' });

    const recoverable = await fx.request('/chat/recoverable', { token });
    assert.equal(recoverable.status, 200);
    assert.equal(recoverable.body.conversations.length, 1);
    assert.equal(recoverable.body.conversations[0].conversationId, conversationId);

    const recovered = await fx.request(`/conversations/${conversationId}/recover`, { method: 'POST', token });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.recovered.length, 1);
    assert.equal(recovered.body.recovered[0].id, stuck.id);

    const conversation = await fx.request(`/conversations/${conversationId}`, { token });
    const swept = conversation.body.messages.find((m) => m.id === stuck.id);
    assert.equal(swept.status, 'interrupted');

    // Nothing left to recover.
    assert.equal((await fx.request('/chat/recoverable', { token })).body.conversations.length, 0);
  } finally { await fx.close(); }
});

test('conversations are isolated per user and per tenant', async () => {
  const fx = await fixture();
  try {
    const alice = await fx.register('alice@chat.test');
    const bob = await fx.register('bob@chat.test');
    const created = await fx.request('/conversations', { method: 'POST', token: alice.token, body: { title: 'Alice private' } });
    const id = created.body.id;

    // Bob cannot read, rename, delete, or append to Alice's conversation.
    assert.equal((await fx.request(`/conversations/${id}`, { token: bob.token })).status, 404);
    assert.equal((await fx.request(`/conversations/${id}`, { method: 'PATCH', token: bob.token, body: { title: 'hijack' } })).status, 404);
    assert.equal((await fx.request(`/conversations/${id}`, { method: 'DELETE', token: bob.token })).status, 404);
    assert.equal((await fx.request(`/conversations/${id}/messages`, { method: 'POST', token: bob.token, body: { content: 'x' } })).status, 404);
    // Bob's own list is empty.
    assert.equal((await fx.request('/conversations', { token: bob.token })).body.conversations.length, 0);
  } finally { await fx.close(); }
});

test('creating a conversation against an unknown project fails closed', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('proj@chat.test');
    const response = await fx.request('/conversations', { method: 'POST', token, body: { title: 'x', projectId: 'project_does_not_exist' } });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'PROJECT_NOT_FOUND');
  } finally { await fx.close(); }
});

test('ChatStore enforces roles, statuses, and ownership at the unit level', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('unit@chat.test');
    const created = await fx.request('/conversations', { method: 'POST', token, body: { title: 'Unit' } });
    const conversationId = created.body.id;
    const tenantId = (await fx.db.get('SELECT tenant_id FROM conversations WHERE id=?', conversationId)).tenant_id;
    const ownerId = (await fx.db.get('SELECT user_id FROM conversations WHERE id=?', conversationId)).user_id;
    const store = new ChatStore(fx.db);

    // A user-role message requires the owning user.
    assert.throws(() => store.appendMessage({ tenantId, conversationId, role: 'user', content: 'x' }), /CONVERSATION_NOT_FOUND/);
    assert.throws(() => store.appendMessage({ tenantId, conversationId, userId: 'someone_else', role: 'user', content: 'x' }), /CONVERSATION_NOT_FOUND/);
    // Invalid role/status are rejected.
    assert.throws(() => store.appendMessage({ tenantId, conversationId, role: 'robot', content: 'x' }), /CHAT_ROLE_INVALID/);
    assert.throws(() => store.appendMessage({ tenantId, conversationId, role: 'assistant', content: 'x', status: 'bogus' }), /CHAT_STATUS_INVALID/);
    // Updating an unknown message fails closed.
    assert.throws(() => store.updateMessage({ tenantId, messageId: 'msg_missing', patch: { content: 'y' } }), /CHAT_MESSAGE_NOT_FOUND/);

    // A valid assistant write works and is returned serialized.
    const assistant = store.appendMessage({ tenantId, conversationId, role: 'assistant', content: 'ok', status: 'complete', provider: 'test', usage: { totalTokens: 1 } });
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.usage.totalTokens, 1);
    assert.equal(ownerId, (await fx.db.get('SELECT user_id FROM conversations WHERE id=?', conversationId)).user_id);
  } finally { await fx.close(); }
});
