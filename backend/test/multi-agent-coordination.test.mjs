import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AGENT_ROLES,
  createMultiAgentOrchestrator,
  createTeamBus,
  roleForKind,
  selectRoleForNode,
} from '../agent/multi-agent.mjs';
import { TaskGraph, executeTaskGraph, summarizeTaskGraph } from '../../phase2-core/platform.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

/**
 * Stronger multi-agent coordination: capability-aware role selection, a bounded
 * shared context/evidence bus, deterministic result reconciliation, and bounded
 * parallelism. The pure pieces are unit-tested; the orchestration is exercised
 * end-to-end through the real executor and live tool registry.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-coord-'));

/* ------------------------ capability-aware role selection ----------------- */

test('selectRoleForNode keeps the kind-specific role when no capability view is given', () => {
  for (const kind of ['intelligence', 'planning', 'implementation', 'verification', 'report']) {
    assert.equal(selectRoleForNode({ kind }).id, roleForKind(kind).id);
  }
});

test('selectRoleForNode keeps the primary role when one of its tools is available', () => {
  const role = selectRoleForNode({ kind: 'implementation' }, { availableTools: new Set(['files.read']) });
  assert.equal(role.id, 'implementer');
});

test('selectRoleForNode falls back to a capable role when the primary tools are missing', () => {
  // The implementer's tools are all unavailable, but code.reason is, so the
  // retrieval role (which allows code.reason) is chosen instead of failing.
  const role = selectRoleForNode({ kind: 'implementation' }, { availableTools: new Set(['code.reason']) });
  assert.equal(role.id, 'retrieval');
});

test('selectRoleForNode degrades to the tool-less reporter when nothing is available', () => {
  const role = selectRoleForNode({ kind: 'implementation' }, { availableTools: new Set() });
  assert.equal(role.id, 'reporter', 'a role that needs no tools is the safe last resort');
});

/* ------------------------------ shared team bus --------------------------- */

test('createTeamBus bounds findings and truncates their summary', () => {
  const bus = createTeamBus({ maxFindings: 3 });
  for (let i = 0; i < 6; i += 1) bus.publishFinding({ nodeId: `n${i}`, kind: 'task', role: 'generalist', text: 'x'.repeat(5_000), tools: ['files.read'] });
  const view = bus.view();
  assert.equal(view.teamFindings.length, 3, 'findings must be bounded');
  assert.equal(view.teamFindings[0].nodeId, 'n3', 'the oldest findings are dropped first');
  assert.ok(view.teamFindings[0].summary.length <= 1_200, 'a finding summary must be truncated');
});

test('createTeamBus tracks evidence ids and artifacts', () => {
  const bus = createTeamBus();
  bus.publishEvidence('ev1', { nodeId: 'n1', toolId: 'files.read', ok: true });
  bus.publishEvidence(null);
  bus.publishArtifact({ path: 'report.md' });
  const view = bus.view();
  assert.deepEqual(view.evidenceIds, ['ev1']);
  assert.deepEqual(view.artifacts, [{ path: 'report.md' }]);
});

/* ------------------------------ reconciliation ---------------------------- */

test('summarizeTaskGraph reports a consistent verdict for a fully completed graph', () => {
  const graph = new TaskGraph('g', [
    { id: 'a', title: 'A', kind: 'task' },
    { id: 'b', title: 'B', kind: 'task', dependsOn: ['a'] },
  ]);
  for (const node of graph.nodes) { node.status = 'completed'; node.result = { ok: true }; }
  const summary = summarizeTaskGraph(graph);
  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.consistent, true);
  assert.deepEqual(summary.missingResults, []);
});

test('summarizeTaskGraph flags failed nodes and missing results as inconsistent', () => {
  const graph = new TaskGraph('g', [
    { id: 'a', title: 'A', kind: 'task' },
    { id: 'b', title: 'B', kind: 'task' },
  ]);
  graph.nodes[0].status = 'completed';
  graph.nodes[0].result = null;
  graph.nodes[1].status = 'failed';
  graph.nodes[1].error = 'boom';
  const summary = summarizeTaskGraph(graph);
  assert.equal(summary.consistent, false);
  assert.deepEqual(summary.failedNodes, ['b']);
  assert.deepEqual(summary.missingResults, ['a']);
});

/* --------------------------- bounded parallelism -------------------------- */

function independentGraph(count) {
  return new TaskGraph('g', Array.from({ length: count }, (_, index) => ({ id: `n${index}`, title: `N${index}`, kind: 'task' })));
}

test('executeTaskGraph runs independent nodes concurrently by default', async () => {
  const graph = independentGraph(3);
  let active = 0;
  let maxActive = 0;
  const runner = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return { ok: true };
  };
  const result = await executeTaskGraph(graph, runner);
  assert.equal(maxActive, 3, 'the default is unbounded parallelism');
  assert.equal(result.summary.consistent, true);
});

test('executeTaskGraph honours maxParallel to bound concurrency', async () => {
  const graph = independentGraph(3);
  let active = 0;
  let maxActive = 0;
  const runner = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { ok: true };
  };
  const result = await executeTaskGraph(graph, runner, { maxParallel: 1 });
  assert.equal(maxActive, 1, 'maxParallel=1 must serialise the batch');
  assert.equal(result.summary.completed, 3);
});

/* ------------------------------ orchestration ----------------------------- */

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

test('orchestrate reconciles the team and produces a final synthesis', async () => {
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
  const events = [];
  const orchestrator = createMultiAgentOrchestrator({
    llm,
    tools,
    emit: (type, details) => events.push({ type, details }),
    evidence: () => 'ev',
    maxParallel: 2,
  });
  try {
    const result = await orchestrator({ goal: 'inspect the workspace', run: { id: 'run_c', tenant_id: 'tenant_c' }, task: {}, workspaceRoot: dir });
    assert.equal(result.ok, true);
    // Reconciliation is a real, machine-readable verdict over ALL nodes.
    assert.ok(result.reconciliation);
    assert.equal(result.reconciliation.consistent, true);
    assert.equal(result.reconciliation.failed, 0);
    assert.equal(result.reconciliation.total, result.graph.nodes.length);
    // The final synthesis comes from the terminal reporter node.
    assert.equal(result.synthesis, 'final report');
    // Every node carries the role it was actually assigned.
    assert.ok(result.graph.nodes.every((node) => typeof node.role === 'string' && node.role.length > 0));
    assert.ok(events.some((event) => event.type === 'multi_agent_reconciled' && event.details.consistent === true));
    assert.ok(events.some((event) => event.type === 'multi_agent_finished' && event.details.consistent === true));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('orchestrate surfaces an inconsistent reconciliation when a node fails', async () => {
  const dir = await temp();
  const llm = scriptedLLM({
    intelligence: [{ text: 'done' }],
    planning: [{ text: 'done' }],
    // The implementation agent reads a file that does not exist and never recovers.
    implementation: [{ toolId: 'files.read', args: { path: 'missing.txt' } }],
    verification: [{ text: 'done' }],
    report: [{ text: 'done' }],
  });
  const tools = createLiveToolRegistry({ llm, getWorkspaceRoot: () => dir });
  const events = [];
  const orchestrator = createMultiAgentOrchestrator({
    llm,
    tools,
    emit: (type, details) => events.push({ type, details }),
    evidence: () => 'ev',
    maxAttempts: 1,
  });
  try {
    const result = await orchestrator({ goal: 'inspect the workspace', run: { id: 'run_d', tenant_id: 'tenant_d' }, task: {}, workspaceRoot: dir });
    assert.equal(result.ok, false);
    assert.equal(result.reconciliation.consistent, false);
    assert.ok(result.reconciliation.failed >= 1);
    assert.ok(events.some((event) => event.type === 'multi_agent_reconciled' && event.details.consistent === false));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
