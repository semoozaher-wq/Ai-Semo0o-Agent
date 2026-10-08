import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AGENT_ROLES, createMultiAgentOrchestrator, roleForKind, roleToolSchemas } from '../agent/multi-agent.mjs';
import { TOOL_BY_ID } from '../agent/catalog.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-multi-agent-'));

async function readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); if (text.includes('event: close')) break; }
  return text;
}

/**
 * A scripted, provider-agnostic LLM. `script[kind]` is a list of turns; each turn
 * is `{ toolId, args }` (a tool call) or `{ text }` (a final answer). Turns are
 * consumed per node id so a retried node continues its own sequence. The LLM also
 * tracks concurrent in-flight turns so parallel scheduling is observable.
 */
function scriptedLLM(script, { delayMs = 0 } = {}) {
  const turns = new Map();
  const state = { active: 0, maxActive: 0 };
  return {
    state,
    status: () => [{ id: 'test', configured: true }],
    async complete({ messages = [] }) {
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const user = messages.find((message) => message.role === 'user')?.content ?? '{}';
        let payload = {};
        try { payload = JSON.parse(user); } catch { payload = {}; }
        const kind = payload.node?.kind ?? 'task';
        const nodeId = payload.node?.id ?? kind;
        const index = turns.get(nodeId) ?? 0;
        turns.set(nodeId, index + 1);
        const plan = script[kind] ?? [];
        const turn = plan[Math.min(index, plan.length - 1)] ?? { text: `${kind} done` };
        if (turn.toolId) {
          return { provider: 'test', model: 'test', text: '', toolCalls: [{ id: `call_${nodeId}_${index}`, name: turn.toolId.replaceAll('.', '__'), arguments: turn.args ?? {} }], usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } };
        }
        return { provider: 'test', model: 'test', text: turn.text ?? `${kind} done`, toolCalls: [], usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } };
      } finally {
        state.active -= 1;
      }
    },
  };
}

function makeOrchestrator({ llm, tools, maxAttempts = 2, maxTurnsPerAgent = 3 }) {
  const events = [];
  const evidence = [];
  const orchestrator = createMultiAgentOrchestrator({
    llm,
    tools,
    emit: (type, details) => events.push({ type, details }),
    evidence: (toolId, args, result) => { const id = `ev_${evidence.length + 1}`; evidence.push({ id, toolId, args, result }); return id; },
    maxAttempts,
    maxTurnsPerAgent,
  });
  return { orchestrator, events, evidence };
}

const RUN = { id: 'run_multi_1', tenant_id: 'tenant_multi' };

test('multi-agent: every TaskGraph node kind maps to a real role with an allow-listed tool subset', () => {
  for (const kind of ['intelligence', 'planning', 'implementation', 'verification', 'browser', 'retrieval', 'delivery', 'report', 'task']) {
    const role = roleForKind(kind);
    assert.ok(role.id && role.system, `${kind} must map to a real role`);
    for (const toolId of role.tools) assert.ok(TOOL_BY_ID.has(toolId), `${toolId} must exist in the shared catalog`);
  }
  // Unknown kinds fall back to the generalist role (never undefined).
  assert.equal(roleForKind('nonsense').id, 'generalist');
  // Schemas are built from the SAME catalog and only cover the role's allow-list.
  assert.deepEqual(roleToolSchemas(AGENT_ROLES.intelligence).map((schema) => schema.function.name).sort(), ['code__analyze', 'code__impact', 'code__reason', 'doc__extract', 'files__scan', 'git__diff', 'git__log', 'git__status', 'github__ci__status', 'github__issues__list', 'github__repo', 'memory__search', 'web__extract']);
  assert.deepEqual(roleToolSchemas(AGENT_ROLES.report), []);
});

test('multi-agent: runs a real TaskGraph of specialist agents with real tools and evidence', async () => {
  const dir = await temp();
  await writeFile(path.join(dir, 'input.txt'), 'real workspace evidence');
  const llm = scriptedLLM({
    intelligence: [{ toolId: 'files.scan', args: { scope: '.', maxFiles: 20 } }, { text: 'map done' }],
    planning: [{ toolId: 'code.reason', args: { question: 'input', mode: 'search' } }, { text: 'plan done' }],
    implementation: [{ toolId: 'files.read', args: { path: 'input.txt', maxChars: 1000 } }, { text: 'impl done' }],
    verification: [{ toolId: 'code.analyze', args: { path: 'input.txt' } }, { text: 'verify done' }],
    report: [{ text: 'final report' }],
  });
  const tools = createLiveToolRegistry({ llm, getWorkspaceRoot: () => dir });
  const { orchestrator, events, evidence } = makeOrchestrator({ llm, tools });
  try {
    const result = await orchestrator({ goal: 'inspect the workspace', run: RUN, task: {}, workspaceRoot: dir });
    assert.equal(result.ok, true);
    assert.deepEqual(result.graph.nodes.map((node) => node.kind), ['intelligence', 'planning', 'implementation', 'verification', 'report']);
    assert.ok(result.graph.nodes.every((node) => node.status === 'completed'));
    // Real tools ran and produced evidence through the injected sink.
    assert.ok(evidence.some((item) => item.toolId === 'files.scan' && Array.isArray(item.result.output.files)));
    assert.ok(evidence.some((item) => item.toolId === 'files.read' && item.result.output.content.includes('real workspace evidence')));
    // The lifecycle is fully described in the event stream.
    assert.ok(events.some((event) => event.type === 'multi_agent_started'));
    assert.ok(events.some((event) => event.type === 'multi_agent_node_started' && event.details.role === 'analyst'));
    assert.ok(events.some((event) => event.type === 'multi_agent_node_completed' && event.details.role === 'verifier'));
    assert.ok(events.some((event) => event.type === 'multi_agent_finished' && event.details.ok === true));
    // Usage is aggregated across every specialist agent.
    assert.ok(result.usage.totalTokens > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multi-agent: schedules independent specialist agents in parallel', async () => {
  const dir = await temp();
  await writeFile(path.join(dir, 'input.txt'), 'x');
  // "search" adds a retrieval node that only depends on inspect, so it is ready
  // at the same time as planning and does not conflict with it.
  const llm = scriptedLLM({
    intelligence: [{ toolId: 'files.scan', args: {} }, { text: 'done' }],
    planning: [{ toolId: 'code.reason', args: { question: 'x', mode: 'search' } }, { text: 'done' }],
    retrieval: [{ toolId: 'files.read', args: { path: 'input.txt' } }, { text: 'done' }],
    implementation: [{ text: 'done' }],
    verification: [{ text: 'done' }],
    report: [{ text: 'done' }],
  }, { delayMs: 15 });
  const tools = createLiveToolRegistry({ llm, getWorkspaceRoot: () => dir });
  const { orchestrator } = makeOrchestrator({ llm, tools });
  try {
    const result = await orchestrator({ goal: 'inspect and search memory for the workspace', run: RUN, task: {}, workspaceRoot: dir });
    assert.equal(result.ok, true);
    assert.ok(result.graph.nodes.some((node) => node.kind === 'retrieval'));
    assert.ok(llm.state.maxActive >= 2, `independent agents must overlap (maxActive=${llm.state.maxActive})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multi-agent: retries a flaky specialist agent through the executor replan', async () => {
  const dir = await temp();
  await writeFile(path.join(dir, 'input.txt'), 'present');
  const llm = scriptedLLM({
    intelligence: [{ toolId: 'files.scan', args: {} }, { text: 'done' }],
    planning: [{ toolId: 'code.reason', args: { question: 'x', mode: 'search' } }, { text: 'done' }],
    // First attempt reads a missing file (the real tool throws); the retry reads
    // the real file and succeeds.
    implementation: [{ toolId: 'files.read', args: { path: 'missing.txt' } }, { toolId: 'files.read', args: { path: 'input.txt' } }, { text: 'done' }],
    verification: [{ text: 'done' }],
    report: [{ text: 'done' }],
  });
  const tools = createLiveToolRegistry({ llm, getWorkspaceRoot: () => dir });
  const { orchestrator, events } = makeOrchestrator({ llm, tools });
  try {
    const result = await orchestrator({ goal: 'inspect the workspace', run: RUN, task: {}, workspaceRoot: dir });
    assert.equal(result.ok, true);
    assert.ok(events.some((event) => event.type === 'multi_agent_replanned'));
    assert.equal(result.graph.nodes.find((node) => node.kind === 'implementation').attempts, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multi-agent: refuses a dangerous tool the run was not approved for (fail closed)', async () => {
  const dir = await temp();
  const llm = scriptedLLM({
    intelligence: [{ text: 'done' }],
    planning: [{ text: 'done' }],
    implementation: [{ toolId: 'files.write', args: { path: 'out.txt', content: 'should not exist' } }],
    verification: [{ text: 'done' }],
    report: [{ text: 'done' }],
  });
  const tools = createLiveToolRegistry({ llm, getWorkspaceRoot: () => dir });
  const { orchestrator } = makeOrchestrator({ llm, tools, maxAttempts: 1 });
  try {
    const result = await orchestrator({ goal: 'inspect the workspace', run: RUN, task: {}, workspaceRoot: dir });
    assert.equal(result.ok, false);
    const implementation = result.graph.nodes.find((node) => node.kind === 'implementation');
    assert.equal(implementation.status, 'failed');
    assert.match(implementation.error, /AGENT_APPROVAL_REQUIRED/);
    // The write never happened.
    await assert.rejects(() => readFile(path.join(dir, 'out.txt'), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multi-agent: runs an approved dangerous tool for real', async () => {
  const dir = await temp();
  const llm = scriptedLLM({
    intelligence: [{ text: 'done' }],
    planning: [{ text: 'done' }],
    implementation: [{ toolId: 'files.write', args: { path: 'out.txt', content: 'written by implementer' } }, { text: 'done' }],
    verification: [{ text: 'done' }],
    report: [{ text: 'done' }],
  });
  const tools = createLiveToolRegistry({ llm, getWorkspaceRoot: () => dir });
  const { orchestrator } = makeOrchestrator({ llm, tools });
  try {
    const result = await orchestrator({ goal: 'inspect the workspace', run: RUN, task: {}, workspaceRoot: dir, approvedTools: new Set(['files.write']) });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(dir, 'out.txt'), 'utf8'), 'written by implementer');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multi-agent: bounds a specialist agent that never stops calling tools', async () => {
  const dir = await temp();
  const llm = scriptedLLM({
    intelligence: [{ toolId: 'files.scan', args: {} }],
    planning: [{ text: 'done' }],
    implementation: [{ text: 'done' }],
    verification: [{ text: 'done' }],
    report: [{ text: 'done' }],
  });
  const tools = createLiveToolRegistry({ llm, getWorkspaceRoot: () => dir });
  const { orchestrator, evidence } = makeOrchestrator({ llm, tools, maxTurnsPerAgent: 2 });
  try {
    const result = await orchestrator({ goal: 'inspect the workspace', run: RUN, task: {}, workspaceRoot: dir });
    assert.equal(result.ok, true);
    // The analyst stopped at exactly the turn budget instead of looping forever.
    assert.equal(evidence.filter((item) => item.toolId === 'files.scan').length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('multi-agent: an authenticated run with multiAgent:true executes the whole team end to end', async () => {
  const dir = await temp();
  await writeFile(path.join(dir, 'input.txt'), 'e2e workspace evidence');
  const db = new Database(path.join(dir, 'multi.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const llm = scriptedLLM({
    intelligence: [{ toolId: 'files.scan', args: { scope: '.', maxFiles: 20 } }, { text: 'map done' }],
    planning: [{ toolId: 'code.reason', args: { question: 'input', mode: 'search' } }, { text: 'plan done' }],
    implementation: [{ toolId: 'files.read', args: { path: 'input.txt' } }, { text: 'impl done' }],
    verification: [{ toolId: 'code.analyze', args: { path: 'input.txt' } }, { text: 'verify done' }],
    report: [{ text: 'final report' }],
  });
  const tools = createLiveToolRegistry({ db, llm, getWorkspaceRoot: () => dir });
  const app = createApp({ db, queue, llm, liveTools: tools });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => { const response = await fetch(`${base}${route}`, { headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }, ...options, body: options.body ? JSON.stringify(options.body) : undefined }); return { status: response.status, body: await response.json().catch(() => ({})) }; };
  try {
    const registered = await request('/auth/register', { method: 'POST', body: { email: 'multi@example.test', password: 'correct horse battery staple', tenantName: 'Multi' } });
    assert.equal(registered.status, 201);
    const token = registered.body.session.token;
    const project = await request('/projects', { method: 'POST', token, body: { name: 'Multi Project', rootPath: dir } });
    const created = await request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'inspect the workspace', model: 'test', multiAgent: true } });
    assert.equal(created.status, 202);
    queue.start();
    const eventsResponse = await fetch(`${base}/runs/${created.body.runId}/events`, { headers: { authorization: `Bearer ${token}` } });
    const eventsText = await readSse(eventsResponse);
    assert.match(eventsText, /multi_agent_started/);
    assert.match(eventsText, /multi_agent_node_completed/);
    assert.match(eventsText, /run_finished/);
    const finished = await request(`/runs/${created.body.runId}`, { token });
    assert.equal(finished.body.status, 'completed');
    assert.equal(finished.body.result.multiAgent, true);
    assert.ok(finished.body.result.graph.nodes.length >= 5, 'the team must decompose into a real DAG');
    assert.ok(finished.body.evidence.some((item) => item.kind === 'tool.result'), 'real tool evidence must be recorded');
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
