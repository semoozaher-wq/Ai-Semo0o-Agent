import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';

// -----------------------------------------------------------------------------
// Attachment pipeline regression suite.
//
// The chat API used to accept only text: an "attached" file contributed nothing
// but its name/size to the prompt, so the model never saw the real content. This
// suite pins the fixed behaviour end-to-end:
//   * POST /attachments stores the real bytes (tenant+user scoped);
//   * POST /chat and /chat/stream load those bytes and hand the model the ACTUAL
//     content (text inlined; images as OpenAI-style image_url data-URL parts);
//   * a foreign/unknown attachment id fails closed (404), never leaking another
//     tenant's upload;
//   * metadata, download and delete are owner-scoped.
// -----------------------------------------------------------------------------

const TEXT_BODY = 'const secret = 42; // inline-me';
const TEXT_B64 = Buffer.from(TEXT_BODY, 'utf8').toString('base64');
// A valid 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function captureLlm() {
  const captured = { complete: [], stream: [] };
  return {
    captured,
    status: () => [{ id: 'test', model: 'test', configured: true, healthy: true }],
    async complete(input) {
      captured.complete.push(input);
      return { provider: 'test', text: 'ok', usage: { totalTokens: 1 } };
    },
    async *stream(input) {
      captured.stream.push(input);
      yield { type: 'token', text: 'ok' };
      yield { type: 'done', usage: { totalTokens: 1 }, provider: 'test' };
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-attach-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const llm = captureLlm();
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
    if (contentType.includes('json')) return { status: response.status, contentType, body: await response.json().catch(() => ({})) };
    if (contentType.includes('text/event-stream')) return { status: response.status, contentType, body: await response.text() };
    // Anything else (image/*, text/plain, application/octet-stream, …) is a raw
    // artefact download; return the bytes so the caller can compare them.
    return { status: response.status, contentType, buffer: Buffer.from(await response.arrayBuffer()) };
  };
  const register = async (email) => {
    const response = await request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: email } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { token: response.body.session.token, tenantId: response.body.user.tenantId, userId: response.body.user.id };
  };
  return {
    dir, db, queue, app, base, request, register, llm,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('POST /attachments stores bytes and returns owner-scoped metadata', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('upload@attach.test');
    const upload = await fx.request('/attachments', { method: 'POST', token, body: { name: 'snippet.ts', mimeType: 'text/typescript', dataBase64: TEXT_B64 } });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.body.name, 'snippet.ts');
    assert.equal(upload.body.kind, 'code');
    assert.equal(upload.body.sizeBytes, Buffer.byteLength(TEXT_BODY));
    assert.match(upload.body.sha256, /^[0-9a-f]{64}$/);
    assert.ok(upload.body.id.startsWith('att_'));

    const meta = await fx.request(`/attachments/${upload.body.id}`, { token });
    assert.equal(meta.status, 200);
    assert.equal(meta.body.id, upload.body.id);

    const download = await fx.request(`/attachments/${upload.body.id}/content`, { token });
    assert.equal(download.status, 200);
    assert.equal(download.buffer.toString('utf8'), TEXT_BODY);

    const removed = await fx.request(`/attachments/${upload.body.id}`, { method: 'DELETE', token });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
    assert.equal((await fx.request(`/attachments/${upload.body.id}`, { token })).status, 404);
  } finally { await fx.close(); }
});

test('POST /chat inlines the real text content of an attachment', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('chat-attach@attach.test');
    const upload = await fx.request('/attachments', { method: 'POST', token, body: { name: 'snippet.ts', mimeType: 'text/typescript', dataBase64: TEXT_B64 } });
    assert.equal(upload.status, 201);

    const chat = await fx.request('/chat', { method: 'POST', token, body: { message: 'اقرأ الملف', attachmentIds: [upload.body.id] } });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));

    const sent = fx.llm.captured.complete.at(-1);
    const userTurn = sent.messages.find((message) => message.role === 'user');
    assert.equal(typeof userTurn.content, 'string');
    assert.ok(userTurn.content.includes(TEXT_BODY), 'the model must receive the actual file bytes as text');
    assert.ok(userTurn.content.includes('اقرأ الملف'));
  } finally { await fx.close(); }
});

test('POST /chat/stream sends images as vision parts and text inline', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('stream-attach@attach.test');
    const image = await fx.request('/attachments', { method: 'POST', token, body: { name: 'pixel.png', mimeType: 'image/png', dataBase64: PNG_B64 } });
    const text = await fx.request('/attachments', { method: 'POST', token, body: { name: 'notes.txt', mimeType: 'text/plain', dataBase64: TEXT_B64 } });
    assert.equal(image.status, 201);
    assert.equal(text.status, 201);

    const response = await fetch(`${fx.base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: 'صف الصورة', attachmentIds: [image.body.id, text.body.id] }),
    });
    assert.equal(response.status, 200);
    await response.text();

    const sent = fx.llm.captured.stream.at(-1);
    const userTurn = sent.messages.find((message) => message.role === 'user');
    assert.ok(Array.isArray(userTurn.content), 'a turn with an image must be multimodal');
    const imagePart = userTurn.content.find((part) => part.type === 'image_url');
    assert.ok(imagePart, 'the image must be sent as an image_url part');
    assert.ok(imagePart.image_url.url.startsWith('data:image/png;base64,'));
    const textPart = userTurn.content.find((part) => part.type === 'text');
    assert.ok(textPart.text.includes(TEXT_BODY), 'text files are inlined alongside the image');
  } finally { await fx.close(); }
});

test('an attachment from another tenant is invisible and unusable (fail closed)', async () => {
  const fx = await fixture();
  try {
    const alice = await fx.register('alice@attach.test');
    const bob = await fx.register('bob@attach.test');
    const upload = await fx.request('/attachments', { method: 'POST', token: alice.token, body: { name: 'private.txt', mimeType: 'text/plain', dataBase64: TEXT_B64 } });
    assert.equal(upload.status, 201);

    // Bob cannot read, download, delete, or reference Alice's attachment.
    assert.equal((await fx.request(`/attachments/${upload.body.id}`, { token: bob.token })).status, 404);
    assert.equal((await fx.request(`/attachments/${upload.body.id}/content`, { token: bob.token })).status, 404);
    assert.equal((await fx.request(`/attachments/${upload.body.id}`, { method: 'DELETE', token: bob.token })).status, 404);
    const chat = await fx.request('/chat', { method: 'POST', token: bob.token, body: { message: 'hi', attachmentIds: [upload.body.id] } });
    assert.equal(chat.status, 404, JSON.stringify(chat.body));
  } finally { await fx.close(); }
});

test('invalid base64 is rejected with 400 and an image-only turn is accepted', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('invalid@attach.test');
    const bad = await fx.request('/attachments', { method: 'POST', token, body: { name: 'x.txt', mimeType: 'text/plain', dataBase64: 'not base64 @@@' } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));

    const missing = await fx.request('/chat', { method: 'POST', token, body: { message: '   ' } });
    assert.equal(missing.status, 400);

    const image = await fx.request('/attachments', { method: 'POST', token, body: { name: 'pixel.png', mimeType: 'image/png', dataBase64: PNG_B64 } });
    const imageOnly = await fx.request('/chat', { method: 'POST', token, body: { message: '', attachmentIds: [image.body.id] } });
    assert.equal(imageOnly.status, 200, JSON.stringify(imageOnly.body));
  } finally { await fx.close(); }
});

test('agent runs inline attachment content into the goal', async () => {
  const fx = await fixture();
  try {
    const { token } = await fx.register('agent-attach@attach.test');
    const upload = await fx.request('/attachments', { method: 'POST', token, body: { name: 'spec.md', mimeType: 'text/markdown', dataBase64: TEXT_B64 } });
    const project = await fx.request('/projects', { method: 'POST', token, body: { name: 'P', rootPath: path.join(fx.dir, 'ws') } });
    assert.equal(project.status, 201, JSON.stringify(project.body));

    const run = await fx.request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'حلّل المواصفات', attachmentIds: [upload.body.id] } });
    assert.equal(run.status, 202, JSON.stringify(run.body));

    // The task goal persisted for the run must contain the real file content.
    const task = fx.db.get('SELECT goal FROM tasks WHERE id=?', run.body.taskId);
    assert.ok(task.goal.includes(TEXT_BODY), 'the agent goal must carry the attachment content');
  } finally { await fx.close(); }
});
