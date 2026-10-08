import assert from 'node:assert/strict';
import test from 'node:test';

import { TaskGraph, executeTaskGraph } from '../../phase2-core/platform.mjs';

/**
 * Dynamic autonomous planning: `TaskGraph.decompose` turns a goal into a DAG
 * using a model, but ALWAYS keeps the deterministic heuristic planner
 * (`fromGoal`) as a safe fallback. These tests prove the model path, the
 * fallback paths (no model / bad output / cyclic output), dependency
 * normalization, and the existing executor's parallel-batch + conflict +
 * replan/recovery behaviour.
 */

function fakeLlm(plan) {
  return {
    calls: [],
    async complete(args) {
      this.calls.push(args);
      return { text: typeof plan === 'function' ? plan(args) : plan };
    },
  };
}

test('decompose: builds a validated DAG from a model plan and marks it as model-sourced', async () => {
  const plan = JSON.stringify({
    nodes: [
      { id: 'inspect', title: 'Inspect repo', kind: 'intelligence', dependsOn: [], reads: ['workspace'], writes: ['index'] },
      { id: 'implement', title: 'Implement change', kind: 'implementation', dependsOn: ['inspect'], reads: ['index'], writes: ['workspace'] },
      { id: 'verify', title: 'Run tests', kind: 'verification', dependsOn: ['implement'], reads: ['workspace'], writes: ['evidence'] },
      { id: 'report', title: 'Report', kind: 'report', dependsOn: [], reads: ['evidence'], writes: ['report'] },
    ],
  });
  const llm = fakeLlm(plan);
  const graph = await TaskGraph.decompose('Add a health endpoint', {}, { llm, model: 'test-model' });
  assert.equal(graph.planSource, 'model');
  assert.equal(graph.nodes.length, 4);
  assert.deepEqual(graph.nodes.map((node) => node.kind), ['intelligence', 'implementation', 'verification', 'report']);
  // The report node was auto-wired to the leaves (verify).
  const report = graph.nodes.find((node) => node.kind === 'report');
  assert.deepEqual(report.dependsOn, ['verify']);
  // The model was actually asked (system + user messages present).
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].messages.length, 2);
});

test('decompose: falls back to the heuristic planner when no model is provided', async () => {
  const graph = await TaskGraph.decompose('Refactor the auth module', {});
  assert.equal(graph.planSource, 'heuristic');
  const reference = TaskGraph.fromGoal('Refactor the auth module', {});
  assert.equal(graph.nodes.length, reference.nodes.length);
  assert.deepEqual(graph.nodes.map((node) => node.kind), reference.nodes.map((node) => node.kind));
});

test('decompose: falls back when the model throws or returns unusable text', async () => {
  const throwing = { async complete() { throw new Error('MODEL_DOWN'); } };
  const graphA = await TaskGraph.decompose('goal', {}, { llm: throwing });
  assert.equal(graphA.planSource, 'heuristic');

  const garbage = fakeLlm('I think you should just do it, no JSON here.');
  const graphB = await TaskGraph.decompose('goal', {}, { llm: garbage });
  assert.equal(graphB.planSource, 'heuristic');

  const empty = fakeLlm(JSON.stringify({ nodes: [] }));
  const graphC = await TaskGraph.decompose('goal', {}, { llm: empty });
  assert.equal(graphC.planSource, 'heuristic');
});

test('decompose: rejects a cyclic model plan and falls back instead of throwing', async () => {
  const plan = JSON.stringify({
    nodes: [
      { id: 'a', title: 'A', kind: 'task', dependsOn: ['b'] },
      { id: 'b', title: 'B', kind: 'task', dependsOn: ['a'] },
    ],
  });
  const graph = await TaskGraph.decompose('goal', {}, { llm: fakeLlm(plan) });
  assert.equal(graph.planSource, 'heuristic');
});

test('decompose: normalizes dependencies given by title/index, dedupes ids and coerces unknown kinds', async () => {
  const plan = JSON.stringify({
    nodes: [
      { id: 'Plan It', title: 'Plan It', kind: 'planning' },
      { id: 'plan-it', title: 'Duplicate slug', kind: 'implementation', dependsOn: ['Plan It'] },
      { id: 'verify', title: 'Verify', kind: 'verification', dependsOn: [0] },
      { id: 'weird', title: 'Weird', kind: 'not-a-kind', dependsOn: ['verify'] },
      { id: 'report', title: 'Report', kind: 'report' },
    ],
  });
  const graph = await TaskGraph.decompose('goal', {}, { llm: fakeLlm(plan) });
  assert.equal(graph.planSource, 'model');
  const ids = graph.nodes.map((node) => node.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  assert.ok(ids.includes('plan-it') && ids.includes('plan-it-2'), 'duplicate slug deduped');
  // 'not-a-kind' was coerced to the general 'task' kind.
  assert.equal(graph.nodes.find((node) => node.id === 'weird').kind, 'task');
  // dependsOn by title resolved to the slugified id.
  assert.deepEqual(graph.nodes.find((node) => node.id === 'plan-it-2').dependsOn, ['plan-it']);
  // dependsOn by 0-based index resolved to the first node's id.
  assert.deepEqual(graph.nodes.find((node) => node.id === 'verify').dependsOn, ['plan-it']);
  // report auto-wired to the current leaves.
  assert.deepEqual(graph.nodes.find((node) => node.id === 'report').dependsOn, ['plan-it-2', 'weird']);
});

test('decompose: maxNodes bounds the plan size', async () => {
  const nodes = Array.from({ length: 30 }, (_, index) => ({ id: `n${index}`, title: `Step ${index}`, kind: 'task' }));
  const graph = await TaskGraph.decompose('goal', {}, { llm: fakeLlm(JSON.stringify({ nodes })), maxNodes: 5 });
  assert.equal(graph.planSource, 'model');
  assert.equal(graph.nodes.length, 5);
});

test('executeTaskGraph: independent nodes run in the same parallel batch, conflicting writes are serialized', async () => {
  const graph = new TaskGraph('parallel demo', [
    { id: 'a', title: 'A', kind: 'task', writes: ['x'] },
    { id: 'b', title: 'B', kind: 'task', writes: ['y'] },
    { id: 'c', title: 'C', kind: 'task', writes: ['x'] },
  ]);
  let active = 0;
  let maxActive = 0;
  const order = [];
  const runner = async (node) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    order.push(node.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    active -= 1;
    return node.id;
  };
  const result = await executeTaskGraph(graph, runner, { maxAttempts: 1 });
  assert.equal(result.ok, true);
  // a and b are independent (no shared resource) -> ran concurrently.
  assert.equal(maxActive, 2);
  // c conflicts with a (both write 'x') -> must run after a.
  assert.ok(order.indexOf('c') > order.indexOf('a'));
});

test('executeTaskGraph: a failing node is retried via replan and can recover', async () => {
  const graph = new TaskGraph('recovery demo', [{ id: 'n1', title: 'Flaky', kind: 'task', writes: ['x'] }]);
  let attempts = 0;
  let replanned = 0;
  const result = await executeTaskGraph(graph, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient failure');
    return 'recovered';
  }, {
    maxAttempts: 2,
    replan: async () => { replanned += 1; },
  });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.equal(replanned, 1);
  assert.ok(result.events.some((event) => event.type === 'replanned'));
  assert.ok(result.events.some((event) => event.type === 'completed'));
});

test('executeTaskGraph: a node that exhausts its attempts fails and stops the graph', async () => {
  const graph = new TaskGraph('failure demo', [{ id: 'n1', title: 'Always fails', kind: 'task' }]);
  const result = await executeTaskGraph(graph, async () => { throw new Error('permanent'); }, { maxAttempts: 2, replan: async () => {} });
  assert.equal(result.ok, false);
  assert.equal(graph.nodes[0].status, 'failed');
});
