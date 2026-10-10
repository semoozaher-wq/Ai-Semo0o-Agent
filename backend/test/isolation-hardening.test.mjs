import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';

/**
 * Isolation regression suite for the surfaces added/rewired in the P1/P2 pass:
 * attachment uploads (real bytes to the model) and agent runs. The durable
 * chat/conversation isolation is already covered by chat.test.mjs; this file
 * proves the NEW endpoints keep the same fail-closed, cross-tenant guarantee.
 *
 * Every "foreign" probe must look identical to a missing resource (404), never
 * a 403, so existence is never leaked across tenants.
 */

function mockLlm() {
  return {
    status: () => [{ id: 'test', model: 'test', configured: true }],
    async complete() { return { provider: 'test', text: 'ok', usage: { totalTokens: 1 } }; },
    async *stream() {
      yield { type: 'token', text: 'ok' };
      yield { type: 'done', usage: { totalTokens: 1 }, provider: 'test' };
    },
  };
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-iso-'));
  const workspaceRoot = path.join(dir, 'workspaces');
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm: mockLlm() });
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
    dir, db, queue, app, base, request, register, workspaceRoot,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

const PNG_BASE64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('attachments are isolated per user and per tenant (fail closed)', async () => {
  const fx = await fixture();
  try {
    const alice = await fx.register('alice@iso.test');
    const bob = await fx.register('bob@iso.test');

    const uploaded = await fx.request('/attachments', {
      method: 'POST', token: alice.token,
      body: { name: 'secret.png', mimeType: 'image/png', dataBase64: PNG_BASE64 },
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const attachmentId = uploaded.body.id;
    assert.ok(attachmentId);
    assert.equal(uploaded.body.tenantId, alice.tenantId);
    assert.equal(uploaded.body.userId, alice.userId);

    // Alice can read her own metadata and content.
    assert.equal((await fx.request(`/attachments/${attachmentId}`, { token: alice.token })).status, 200);
    const content = await fx.request(`/attachments/${attachmentId}/content`, { token: alice.token });
    assert.equal(content.status, 200);

    // Bob sees the SAME attachment as missing on every verb (no existence leak).
    assert.equal((await fx.request(`/attachments/${attachmentId}`, { token: bob.token })).status, 404);
    assert.equal((await fx.request(`/attachments/${attachmentId}/content`, { token: bob.token })).status, 404);
    assert.equal((await fx.request(`/attachments/${attachmentId}`, { method: 'DELETE', token: bob.token })).status, 404);

    // Alice's record survives Bob's failed delete attempt.
    assert.equal((await fx.request(`/attachments/${attachmentId}`, { token: alice.token })).status, 200);

    // An unauthenticated caller is rejected before any lookup.
    assert.equal((await fx.request(`/attachments/${attachmentId}`)).status, 401);
  } finally { await fx.close(); }
});

test('an unknown attachment id fails closed for its own owner too', async () => {
  const fx = await fixture();
  try {
    const alice = await fx.register('alice2@iso.test');
    assert.equal((await fx.request('/attachments/att_does_not_exist', { token: alice.token })).status, 404);
    assert.equal((await fx.request('/attachments/att_does_not_exist/content', { token: alice.token })).status, 404);
    assert.equal((await fx.request('/attachments/att_does_not_exist', { method: 'DELETE', token: alice.token })).status, 404);
  } finally { await fx.close(); }
});

test('POST /chat/stream refuses a foreign conversationId (fail closed)', async () => {
  const fx = await fixture();
  try {
    const alice = await fx.register('alice3@iso.test');
    const bob = await fx.register('bob3@iso.test');

    const created = await fx.request('/conversations', { method: 'POST', token: alice.token, body: { title: 'Alice private' } });
    const conversationId = created.body.id;

    const response = await fx.request('/chat/stream', {
      method: 'POST', token: bob.token,
      body: { message: 'hijack', conversationId },
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'CONVERSATION_NOT_FOUND');

    // Alice's conversation is untouched: no message was appended by Bob.
    const after = await fx.request(`/conversations/${conversationId}`, { token: alice.token });
    assert.equal(after.body.messages.length, 0);
  } finally { await fx.close(); }
});

test('POST /chat/stream refuses a foreign attachmentId (fail closed)', async () => {
  const fx = await fixture();
  try {
    const alice = await fx.register('alice4@iso.test');
    const bob = await fx.register('bob4@iso.test');

    const uploaded = await fx.request('/attachments', {
      method: 'POST', token: alice.token,
      body: { name: 'secret.txt', mimeType: 'text/plain', dataBase64: Buffer.from('top secret').toString('base64') },
    });
    const attachmentId = uploaded.body.id;

    const response = await fx.request('/chat/stream', {
      method: 'POST', token: bob.token,
      body: { message: 'peek', attachmentIds: [attachmentId] },
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'ATTACHMENT_NOT_FOUND');
  } finally { await fx.close(); }
});

test('POST /runs refuses a foreign projectId (fail closed)', async () => {
  const fx = await fixture();
  try {
    const alice = await fx.register('alice5@iso.test');
    const bob = await fx.register('bob5@iso.test');

    const project = await fx.request('/projects', { method: 'POST', token: alice.token, body: { name: 'Alice project', rootPath: path.join(fx.workspaceRoot, 'alice') } });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const { projectId, workspaceId } = project.body;

    // Bob cannot launch a run against Alice's project, even with the right workspace.
    const response = await fx.request('/runs', {
      method: 'POST', token: bob.token,
      body: { kind: 'agent.run', goal: 'steal', projectId, workspaceId },
    });
    assert.equal(response.status, 404);
    assert.equal(response.body.error, 'NOT_FOUND');

    // Bob cannot launch against his own (nonexistent) workspace under Alice's project.
    const response2 = await fx.request('/runs', {
      method: 'POST', token: bob.token,
      body: { kind: 'agent.run', goal: 'steal', projectId, workspaceId: 'workspace_fake' },
    });
    assert.equal(response2.status, 404);

    // Alice can launch against her own project/workspace. `requiresApproval`
    // keeps the run parked (waiting_approval) so the test never executes it.
    const ok = await fx.request('/runs', {
      method: 'POST', token: alice.token,
      body: { kind: 'agent.run', goal: 'legit', projectId, workspaceId, requiresApproval: true },
    });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.ok(ok.body.runId);
  } finally { await fx.close(); }
});

test('POST /runs refuses a foreign workspaceId under a legitimate project', async () => {
  const fx = await fixture();
  try {
    const alice = await fx.register('alice6@iso.test');
    const bob = await fx.register('bob6@iso.test');

    const aliceProject = await fx.request('/projects', { method: 'POST', token: alice.token, body: { name: 'Alice', rootPath: path.join(fx.workspaceRoot, 'alice2') } });
    const bobProject = await fx.request('/projects', { method: 'POST', token: bob.token, body: { name: 'Bob', rootPath: path.join(fx.workspaceRoot, 'bob2') } });
    assert.equal(aliceProject.status, 201, JSON.stringify(aliceProject.body));
    assert.equal(bobProject.status, 201, JSON.stringify(bobProject.body));

    // Bob's own project + Alice's workspace id must not resolve.
    const response = await fx.request('/runs', {
      method: 'POST', token: bob.token,
      body: { kind: 'agent.run', goal: 'x', projectId: bobProject.body.projectId, workspaceId: aliceProject.body.workspaceId },
    });
    assert.equal(response.status, 404);
  } finally { await fx.close(); }
});
