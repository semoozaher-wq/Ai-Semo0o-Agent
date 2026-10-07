import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRouter } from '../models/router.mjs';
import { MaestroModelRouter, TASK_TYPES, TASK_TYPE_MODELS, classifyTask } from '../models/task-router.mjs';
import { SUPPORTED_MODELS, modelProvider } from '../models/catalog.mjs';

/* -------------------------------------------------------------------------- */
/*  Task classification                                                       */
/* -------------------------------------------------------------------------- */

test('classifyTask maps goals to the right task type', () => {
  assert.equal(classifyTask('Fix the bug in this function and add a test'), 'code');
  assert.equal(classifyTask('Summarize this long PDF document'), 'long_context');
  assert.equal(classifyTask({ goal: 'Describe this image', needsVision: true }), 'vision');
  assert.equal(classifyTask('Prove the theorem using logic'), 'reasoning');
  assert.equal(classifyTask('Quick simple greeting'), 'fast');
  assert.equal(classifyTask('Hello there'), 'general');
});

test('explicit hints win over keyword heuristics', () => {
  assert.equal(classifyTask({ goal: 'do the thing', taskType: 'code' }), 'code');
  assert.equal(classifyTask({ goal: 'fix the bug', needsVision: true }), 'vision');
  assert.equal(classifyTask({ goal: 'say hi', contextTokens: 400_000 }), 'long_context');
});

/* -------------------------------------------------------------------------- */
/*  Routing                                                                   */
/* -------------------------------------------------------------------------- */

test('every task type routes to a real supported model and a cross-family chain', () => {
  const router = new MaestroModelRouter();
  for (const taskType of TASK_TYPES) {
    const decision = router.route({ taskType });
    assert.ok(SUPPORTED_MODELS[decision.model], `${taskType} -> ${decision.model} must be in the catalog`);
    assert.equal(decision.provider, modelProvider(decision.model));
    assert.ok(decision.chain.length >= 3, `${taskType} chain must offer real fallbacks`);
    assert.ok(new Set(decision.chain.map((id) => modelProvider(id))).size >= 2, `${taskType} chain must span providers`);
  }
});

test('each task type picks its preferred family (Claude / GPT / Gemini)', () => {
  const router = new MaestroModelRouter();
  assert.equal(router.route({ taskType: 'code' }).model, 'claude-sonnet-4-6');
  assert.equal(router.route({ taskType: 'reasoning' }).model, 'gpt-5');
  assert.equal(router.route({ taskType: 'vision' }).model, 'gemini-3.1-pro-preview');
  assert.equal(router.route({ taskType: 'long_context' }).model, 'gemini-3.1-pro-preview');
  assert.equal(router.route({ taskType: 'fast' }).model, 'gpt-5-mini');
  assert.equal(router.route({ taskType: 'general' }).model, 'gpt-5-mini');
});

test('classification drives routing end to end', () => {
  const router = new MaestroModelRouter();
  assert.equal(router.route({ goal: 'refactor this function' }).taskType, 'code');
  assert.equal(router.route({ goal: 'refactor this function' }).model, 'claude-sonnet-4-6');
  assert.equal(router.route({ goal: 'summarize the whole document' }).taskType, 'long_context');
});

test('a large context requirement filters the chain to long-context models', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'general', contextTokens: 500_000 });
  assert.ok(decision.chain.length >= 1);
  for (const id of decision.chain) assert.ok(SUPPORTED_MODELS[id].context >= 500_000, `${id} must fit the context`);
  assert.equal(decision.model, 'gemini-2.5-flash-lite');
});

test('a maxCost budget filters the chain by blended price', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'reasoning', maxCost: 3 });
  assert.ok(decision.chain.length >= 1);
  for (const id of decision.chain) {
    const spec = SUPPORTED_MODELS[id];
    assert.ok((spec.input + spec.output) / 2 <= 3, `${id} must fit the budget`);
  }
});

test('an unhealthy model drops out of the chain and the next one is used', () => {
  const router = new MaestroModelRouter();
  assert.equal(router.route({ taskType: 'code' }).model, 'claude-sonnet-4-6');
  router.updateHealth('claude-sonnet-4-6', false);
  const next = router.route({ taskType: 'code' });
  assert.equal(next.model, 'gpt-5');
  assert.ok(!next.chain.includes('claude-sonnet-4-6'));
});

test('fails closed when no model satisfies the requirements', () => {
  const router = new MaestroModelRouter();
  assert.throws(() => router.route({ taskType: 'general', contextTokens: 5_000_000 }), /NO_HEALTHY_MODEL_FOR_REQUIREMENTS/);
});

/* -------------------------------------------------------------------------- */
/*  Fallback                                                                  */
/* -------------------------------------------------------------------------- */

test('runWithFallback tries models in order until one succeeds', async () => {
  const router = new MaestroModelRouter();
  const tried = [];
  const outcome = await router.runWithFallback(['claude-sonnet-4-6', 'gpt-5', 'gemini-3.1-pro-preview'], async (model) => {
    tried.push(model);
    if (model !== 'gemini-3.1-pro-preview') throw new Error(`DOWN:${model}`);
    return { text: 'ok', model };
  });
  assert.deepEqual(tried, ['claude-sonnet-4-6', 'gpt-5', 'gemini-3.1-pro-preview']);
  assert.equal(outcome.model, 'gemini-3.1-pro-preview');
  assert.equal(outcome.provider, 'gemini');
  assert.equal(outcome.attempts.length, 3);
  assert.equal(outcome.attempts[2].ok, true);
});

test('runWithFallback throws MAESTRO_ALL_MODELS_FAILED when every model fails', async () => {
  const router = new MaestroModelRouter();
  await assert.rejects(
    () => router.runWithFallback(['gpt-5', 'claude-sonnet-4-6'], async (model) => { throw new Error(`DOWN:${model}`); }),
    /MAESTRO_ALL_MODELS_FAILED/,
  );
});

test('createRoutedLLM is a drop-in llm that routes by task type and falls back', async () => {
  const router = new MaestroModelRouter();
  const calls = [];
  const base = {
    status: () => [{ id: 'base', configured: true }],
    async complete({ model }) {
      calls.push(model);
      if (model === 'claude-sonnet-4-6') throw new Error('PRIMARY_DOWN');
      return { provider: 'openai', model, text: 'planned', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, toolCalls: [] };
    },
  };
  const routed = router.createRoutedLLM({ llm: base, taskType: 'code' });
  assert.equal(typeof routed.complete, 'function');
  assert.equal(typeof routed.status, 'function');
  const result = await routed.complete({ model: 'ignored', messages: [] });
  assert.deepEqual(calls, ['claude-sonnet-4-6', 'gpt-5']);
  assert.equal(result.routedModel, 'gpt-5');
  assert.equal(result.routeTaskType, 'code');
  assert.equal(result.routeAttempts.length, 2);
  assert.equal(result.text, 'planned');
});

test('createRoutedLLM can honour an explicitly requested model first', async () => {
  const router = new MaestroModelRouter();
  const calls = [];
  const base = { async complete({ model }) { calls.push(model); return { model, text: 'ok', usage: {}, toolCalls: [] }; } };
  const routed = router.createRoutedLLM({ llm: base, taskType: 'general', honorRequestedModel: true });
  await routed.complete({ model: 'claude-sonnet-4-6', messages: [] });
  assert.equal(calls[0], 'claude-sonnet-4-6');
});

test('createRoutedLLM requires a real llm', () => {
  const router = new MaestroModelRouter();
  assert.throws(() => router.createRoutedLLM({ llm: {} }), /ROUTED_LLM_REQUIRES_COMPLETE/);
});

/* -------------------------------------------------------------------------- */
/*  Backward compatibility of the extended ModelRouter                        */
/* -------------------------------------------------------------------------- */

test('ModelRouter keeps its original behaviour and adds optional priority/rank', () => {
  const router = new ModelRouter([
    { id: 'cheap', taskTypes: ['general'], contextTokens: 1000, costPer1k: 0.1, latencyMs: 100 },
    { id: 'vision', vision: true, contextTokens: 5000, costPer1k: 1, latencyMs: 200 },
  ]);
  assert.equal(router.choose({ taskType: 'general' }).id, 'cheap');
  assert.equal(router.choose({ needsVision: true }).id, 'vision');
  router.updateHealth('vision', false);
  assert.throws(() => router.choose({ needsVision: true }), /NO_HEALTHY_MODEL/);

  const prioritized = new ModelRouter([
    { id: 'low', costPer1k: 0, latencyMs: 1 },
    { id: 'high', priority: 5, costPer1k: 9, latencyMs: 500 },
  ]);
  assert.equal(prioritized.choose({}).id, 'high');
  assert.deepEqual(prioritized.rank({}).map((item) => item.id), ['high', 'low']);
});

test('TASK_TYPE_MODELS only references supported models', () => {
  for (const [taskType, chain] of Object.entries(TASK_TYPE_MODELS)) {
    assert.ok(TASK_TYPES.includes(taskType), `unknown task type ${taskType}`);
    for (const id of chain) assert.ok(SUPPORTED_MODELS[id], `${taskType} references unsupported ${id}`);
  }
});
