import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { MaestroModelRouter } from '../models/task-router.mjs';

// A fake base llm that records the model the router selected for every call.
// When `failFirst` is set the very first call fails, which forces the router to
// fall back to the next model in the chain (inside a real agent run).
function recordingLLM(record, { failFirst = false } = {}) {
  let calls = 0;
  const plan = JSON.stringify({ reasoning: 'scan', steps: [{ id: 'step_1', title: 'Scan workspace', toolId: 'files.scan', args: { scope: '.', maxFiles: 20 } }] });
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete({ model }) {
      calls += 1;
      record.models.push(model);
      if (failFirst && calls === 1) throw new Error(`PROVIDER_DOWN:${model}`);
      const planningCall = calls === 1 || (failFirst && calls === 2);
      const stepCall = calls === 2 || (failFirst && calls === 3);
      if (planningCall) return { provider: 'test', model, text: plan, toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
      if (stepCall) return { provider: 'test', model, text: '', toolCalls: [], usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      return { provider: 'test', model, text: 'done', toolCalls: [], usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 } };
    },
  };
}

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); if (text.includes('event: close')) break; }
  return text;
}

async function runAgent({ goal, failFirst }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-router-maestro-'));
  await writeFile(path.join(dir, 'input.txt'), 'real workspace evidence');
  const db = new Database(path.join(dir, 'router.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const record = { models: [] };
  const router = new MaestroModelRouter();
  const routed = router.createRoutedLLM({ llm: recordingLLM(record, { failFirst }), goal });
  const tools = createLiveToolRegistry({ db, llm: routed, getWorkspaceRoot: () => dir });
  const app = createApp({ db, queue, llm: routed, liveTools: tools });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => { const response = await fetch(`${base}${route}`, { headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }, ...options, body: options.body ? JSON.stringify(options.body) : undefined }); return { status: response.status, body: await response.json() }; };
  try {
    const registered = await request('/auth/register', { method: 'POST', body: { email: 'router@example.test', password: 'correct horse battery staple', tenantName: 'Router' } });
    const token = registered.body.session.token;
    const project = await request('/projects', { method: 'POST', token, body: { name: 'Router Project', rootPath: dir } });
    const created = await request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal, model: 'test' } });
    assert.equal(created.status, 202);
    queue.start();
    const eventsResponse = await fetch(`${base}/runs/${created.body.runId}/events`, { headers: { authorization: `Bearer ${token}` } });
    await readSse(eventsResponse);
    const finished = await request(`/runs/${created.body.runId}`, { token });
    return { status: finished.body.status, record };
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('the Maestro routes a coding task to Claude and completes through the routed llm', async () => {
  const { status, record } = await runAgent({ goal: 'Fix the bug in this function', failFirst: false });
  assert.equal(status, 'completed');
  assert.ok(record.models.length >= 3);
  assert.ok(record.models.every((model) => model === 'claude-sonnet-4-6'), `expected every call to use Claude, got ${record.models.join(',')}`);
});

test('the Maestro falls back to the next provider when the preferred model fails', async () => {
  const { status, record } = await runAgent({ goal: 'Fix the bug in this function', failFirst: true });
  assert.equal(status, 'completed');
  assert.equal(record.models[0], 'claude-sonnet-4-6');
  assert.equal(record.models[1], 'gpt-5');
  assert.ok(record.models.includes('gpt-5'), 'the run must continue on the fallback model');
});
