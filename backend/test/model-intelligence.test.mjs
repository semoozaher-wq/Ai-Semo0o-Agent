import assert from 'node:assert/strict';
import test from 'node:test';

import { ModelRouter } from '../models/router.mjs';
import { MaestroModelRouter, TASK_TYPES, ROUTE_OBJECTIVES } from '../models/task-router.mjs';
import { SUPPORTED_MODELS } from '../models/catalog.mjs';

/**
 * Model intelligence: capability-aware selection plus cost/latency/quality
 * objectives layered on the EXISTING task-type router. The default policy is
 * unchanged; these tests prove the additive behaviour and the fail-closed
 * capability guard.
 */

test('capabilities() reports a real profile for every supported model', () => {
  const router = new MaestroModelRouter();
  for (const id of Object.keys(SUPPORTED_MODELS)) {
    const caps = router.capabilities(id);
    assert.equal(caps.id, id);
    assert.equal(caps.provider, SUPPORTED_MODELS[id].provider);
    assert.equal(caps.contextTokens, SUPPORTED_MODELS[id].context);
    assert.equal(typeof caps.tools, 'boolean');
    assert.equal(typeof caps.json, 'boolean');
    assert.equal(typeof caps.vision, 'boolean');
    assert.ok(caps.quality > 0 && caps.quality <= 1, `${id} quality in (0,1]`);
    assert.ok(Number.isFinite(caps.costPer1k) && caps.costPer1k >= 0);
    assert.ok(Number.isFinite(caps.latencyMs) && caps.latencyMs > 0);
  }
});

test('the default route (no requires/optimize) is unchanged: priority policy wins', () => {
  const router = new MaestroModelRouter();
  assert.equal(router.route({ taskType: 'code' }).model, 'claude-sonnet-4-6');
  assert.equal(router.route({ taskType: 'reasoning' }).model, 'gpt-5');
  assert.equal(router.route({ taskType: 'general' }).model, 'gpt-5-mini');
  assert.equal(router.route({ taskType: 'code' }).optimize, 'balanced');
});

test('optimize=cost picks the cheapest eligible model and orders the chain by price', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'general', optimize: 'cost' });
  assert.equal(decision.model, 'gemini-2.5-flash-lite');
  const costs = decision.chain.map((id) => router.capabilities(id).costPer1k);
  for (let index = 1; index < costs.length; index += 1) assert.ok(costs[index] >= costs[index - 1], 'chain must be non-decreasing in cost');
});

test('optimize=latency picks the fastest eligible model', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'general', optimize: 'latency' });
  assert.equal(decision.model, 'gemini-2.5-flash-lite');
  const latencies = decision.chain.map((id) => router.capabilities(id).latencyMs);
  for (let index = 1; index < latencies.length; index += 1) assert.ok(latencies[index] >= latencies[index - 1], 'chain must be non-decreasing in latency');
});

test('optimize=quality picks the highest-quality eligible model', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'general', optimize: 'quality' });
  assert.equal(decision.model, 'gpt-5');
  const qualities = decision.chain.map((id) => router.capabilities(id).quality);
  for (let index = 1; index < qualities.length; index += 1) assert.ok(qualities[index] <= qualities[index - 1], 'chain must be non-increasing in quality');
});

test('an unknown objective falls back to the balanced policy (never throws)', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'code', optimize: 'nonsense' });
  assert.equal(decision.optimize, 'balanced');
  assert.equal(decision.model, 'claude-sonnet-4-6');
});

test('requires is honored and echoed; a capable model is returned', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'general', requires: { tools: true, json: true, vision: true } });
  const caps = decision.capabilities;
  assert.equal(caps.tools, true);
  assert.equal(caps.json, true);
  assert.equal(caps.vision, true);
  assert.deepEqual(decision.requires, { tools: true, json: true, vision: true });
});

test('a capability requirement that no model satisfies fails closed', () => {
  const router = new MaestroModelRouter();
  assert.throws(
    () => router.route({ taskType: 'general', requires: { tools: true }, contextTokens: 5_000_000 }),
    /NO_HEALTHY_MODEL_FOR_REQUIREMENTS/,
  );
});

test('requires can be combined with a context floor to pick a long-context capable model', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'general', requires: { vision: true }, contextTokens: 500_000 });
  assert.ok(decision.capabilities.contextTokens >= 500_000);
  assert.equal(decision.capabilities.vision, true);
});

test('ModelRouter capability filter excludes a model that lacks a required capability', () => {
  const router = new ModelRouter([
    { id: 'no-tools', taskTypes: ['general'], tools: false, contextTokens: 1000, costPer1k: 0, latencyMs: 1 },
    { id: 'tools-no-json', taskTypes: ['general'], tools: true, json: false, contextTokens: 1000, costPer1k: 5, latencyMs: 5 },
    { id: 'full', taskTypes: ['general'], tools: true, json: true, contextTokens: 1000, costPer1k: 9, latencyMs: 9 },
  ]);
  // Without the requirement the cheapest (but tool-less) model wins.
  assert.equal(router.choose({ taskType: 'general' }).id, 'no-tools');
  // With the requirement the tool-less model is filtered out (fail-closed).
  assert.equal(router.choose({ taskType: 'general', requires: { tools: true } }).id, 'tools-no-json');
  // Requiring both tools and json filters down to the single fully-capable model.
  assert.equal(router.choose({ taskType: 'general', requires: { tools: true, json: true } }).id, 'full');
  // A requirement nothing satisfies fails closed.
  assert.throws(() => router.choose({ taskType: 'general', requires: { tools: true, json: true, vision: true } }), /NO_HEALTHY_MODEL/);
});

test('ROUTE_OBJECTIVES is the documented closed set', () => {
  assert.deepEqual([...ROUTE_OBJECTIVES], ['balanced', 'quality', 'cost', 'latency']);
  for (const taskType of TASK_TYPES) {
    const decision = new MaestroModelRouter().route({ taskType, optimize: 'cost' });
    assert.ok(ROUTE_OBJECTIVES.includes(decision.optimize));
  }
});
