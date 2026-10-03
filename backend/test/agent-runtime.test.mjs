import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

function fakeLLM() {
  let calls = 0;
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete() {
      calls += 1;
      if (calls === 1) return { provider: 'test', text: JSON.stringify({ reasoning: 'scan', steps: [{ id: 'step_1', title: 'Scan workspace', toolId: 'files.scan', args: { scope: '.', maxFiles: 20 } }] }), toolCalls: [], usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
      if (calls === 2) return { provider: 'test', text: '', toolCalls: [], usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      return { provider: 'test', text: 'تم فحص مساحة العمل فعليًا مع دليل من أداة الملفات.', toolCalls: [], usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 } };
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

test('authenticated agent run executes a real workspace tool and streams events', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-agent-e2e-'));
  await writeFile(path.join(dir, 'input.txt'), 'real workspace evidence');
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const llm = fakeLLM();
  const tools = createLiveToolRegistry({ db, llm, getWorkspaceRoot: () => dir });
  const app = createApp({ db, queue, llm, liveTools: tools });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => { const response = await fetch(`${base}${route}`, { headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }, ...options, body: options.body ? JSON.stringify(options.body) : undefined }); return { status: response.status, body: await response.json() }; };
  try {
    const registered = await request('/auth/register', { method: 'POST', body: { email: 'e2e@example.test', password: 'correct horse battery staple', tenantName: 'E2E' } });
    assert.equal(registered.status, 201);
    const token = registered.body.session.token;
    const project = await request('/projects', { method: 'POST', token, body: { name: 'E2E Project', rootPath: dir } });
    const created = await request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'افحص مساحة العمل وأعطني النتيجة', model: 'test' } });
    assert.equal(created.status, 202);
    queue.start();
    const eventsResponse = await fetch(`${base}/runs/${created.body.runId}/events`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(eventsResponse.status, 200);
    const eventsText = await readSse(eventsResponse);
    assert.match(eventsText, /planning_started/);
    assert.match(eventsText, /tool_completed/);
    assert.match(eventsText, /run_finished/);
    const finished = await request(`/runs/${created.body.runId}`, { token });
    assert.equal(finished.body.status, 'completed');
    assert.equal(finished.body.usage.length, 1);
    assert.ok(finished.body.evidence.some((item) => item.kind === 'tool.result'));
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
