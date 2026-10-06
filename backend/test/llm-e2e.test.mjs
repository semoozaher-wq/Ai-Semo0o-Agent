import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
// Real-HTTP end-to-end test for the agent path that used to fail with
// `LLM_HTTP_404` (attempts: 3) before planning even started.
//
// Unlike agent-runtime.test.mjs (which injects a fake LLM), this test wires the
// REAL `createLLMRouter` into the REAL server/queue/runtime and drives it against
// a local OpenAI-compatible HTTP endpoint. It proves the whole path works over
// the wire: agent.run -> queue -> planner -> LLM provider (real HTTP) -> tool
// execution -> evidence -> verification -> final response.
// -----------------------------------------------------------------------------

function startMockOpenAI() {
  const state = { calls: 0, models: [] };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      state.calls += 1;
      state.models.push(body.model);

      const reply = (payload) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };

      // 1) Planner turn -> a valid plan JSON.
      if (state.calls === 1) {
        return reply({ choices: [{ message: { content: JSON.stringify({ reasoning: 'scan the workspace', steps: [{ id: 'step_1', title: 'Scan workspace', toolId: 'files.scan', args: { scope: '.', maxFiles: 20 } }] }) } }], usage });
      }
      // 2) Step turn -> no tool call (runtime falls back to the planned args).
      if (state.calls === 2) {
        return reply({ choices: [{ message: { content: '' } }], usage });
      }
      // 3) Final turn -> a concise answer.
      return reply({ choices: [{ message: { content: 'تم فحص مساحة العمل فعليًا مع دليل من أداة الملفات.' } }], usage });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
    if (text.includes('event: close')) break;
  }
  return text;
}

test('real LLM router: agent.run reaches planning -> tool -> evidence -> verification -> final over HTTP', async () => {
  const mock = await startMockOpenAI();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-llm-e2e-'));
  await writeFile(path.join(dir, 'input.txt'), 'real workspace evidence');
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });

  // The REAL router, pointed at the local OpenAI-compatible endpoint.
  const llm = createLLMRouter({ OPENAI_API_KEY: 'sk-e2e-test', OPENAI_API_BASE: mock.baseUrl });
  const tools = createLiveToolRegistry({ db, llm, getWorkspaceRoot: () => dir });
  const app = createApp({ db, queue, llm, liveTools: tools });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const registered = await request('/auth/register', { method: 'POST', body: { email: 'llm-e2e@example.test', password: 'correct horse battery staple', tenantName: 'LLM E2E' } });
    assert.equal(registered.status, 201);
    const token = registered.body.session.token;
    const project = await request('/projects', { method: 'POST', token, body: { name: 'LLM E2E', rootPath: dir } });
    // The UI default model is an OpenAI model; its provider IS configured here, so
    // it must be used verbatim and the run must not fail with LLM_HTTP_404.
    const created = await request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'افحص مساحة العمل وأعطني النتيجة', model: 'gpt-5' } });
    assert.equal(created.status, 202);
    queue.start();

    const eventsResponse = await fetch(`${base}/runs/${created.body.runId}/events`, { headers: { authorization: `Bearer ${token}` } });
    const eventsText = await readSse(eventsResponse);
    assert.match(eventsText, /planning_started/);
    assert.match(eventsText, /planning_completed/);
    assert.match(eventsText, /tool_completed/);
    assert.match(eventsText, /step_completed/);
    assert.match(eventsText, /run_finished/);
    assert.doesNotMatch(eventsText, /LLM_HTTP_404/);

    const finished = await request(`/runs/${created.body.runId}`, { token });
    assert.equal(finished.body.status, 'completed');
    assert.equal(finished.body.usage.length, 1);
    assert.ok(finished.body.evidence.some((item) => item.kind === 'tool.result'));
    assert.ok(finished.body.evidence.some((item) => item.kind === 'verification'));

    // Every model sent to the OpenAI-compatible endpoint was an OpenAI model.
    assert.ok(mock.state.models.length >= 3, 'planner + step + final turns all hit the provider');
    assert.ok(mock.state.models.every((model) => model === 'gpt-5'), `unexpected model(s): ${mock.state.models.join(',')}`);
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
    await new Promise((resolve) => mock.server.close(resolve));
  }
});
