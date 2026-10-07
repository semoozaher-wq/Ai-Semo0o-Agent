import assert from 'node:assert/strict';
import test from 'node:test';
import { getModel } from '../src/data/models';
import type { ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResult, ProviderId } from '../src/types/model';
import type { LLMProvider } from '../src/services/ai/provider';
import {
  MaestroModelRouter,
  TASK_TYPES,
  TASK_TYPE_MODELS,
  classifyTask,
  validateTaskTypeModels,
} from '../src/services/agent-engine/model-router';

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

class FakeProvider implements LLMProvider {
  readonly live = true;
  requests: ChatCompletionRequest[] = [];

  constructor(
    readonly id: ProviderId,
    private readonly fail = false,
  ) {}

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.requests.push(request);
    if (this.fail) throw new Error(`PROVIDER_DOWN:${this.id}`);
    return { id: 'cmpl', model: request.model, content: 'ok', usage, finishReason: 'stop' };
  }

  async *stream(request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    this.requests.push(request);
    if (this.fail) throw new Error(`PROVIDER_DOWN:${this.id}`);
    yield { id: 'cmpl', delta: 'ok', done: false };
    yield { id: 'cmpl', delta: '', done: true, finishReason: 'stop' };
  }
}

/* -------------------------------------------------------------------------- */
/*  Classification + routing                                                  */
/* -------------------------------------------------------------------------- */

test('classifyTask maps goals to the right task type', () => {
  assert.equal(classifyTask('Fix the bug in this function and add a test'), 'code');
  assert.equal(classifyTask('Summarize this long PDF document'), 'long_context');
  assert.equal(classifyTask({ goal: 'Describe this image', needsVision: true }), 'vision');
  assert.equal(classifyTask('Prove the theorem using logic'), 'reasoning');
  assert.equal(classifyTask('Quick simple greeting'), 'fast');
  assert.equal(classifyTask('Hello there'), 'general');
});

test('every task type routes to a real model and a cross-family chain', () => {
  const router = new MaestroModelRouter();
  for (const taskType of TASK_TYPES) {
    const decision = router.route({ taskType });
    assert.ok(getModel(decision.model), `${taskType} -> ${decision.model} must exist in the catalog`);
    assert.equal(decision.provider, getModel(decision.model)?.provider);
    assert.ok(decision.chain.length >= 3, `${taskType} chain must offer fallbacks`);
    assert.ok(new Set(decision.chain.map((id) => getModel(id)?.provider)).size >= 2, `${taskType} chain must span providers`);
  }
});

test('each task type picks its preferred family (Claude / GPT / Gemini)', () => {
  const router = new MaestroModelRouter();
  assert.equal(router.route({ taskType: 'code' }).model, 'claude-sonnet-4-6');
  assert.equal(router.route({ taskType: 'reasoning' }).model, 'gpt-5');
  assert.equal(router.route({ taskType: 'vision' }).model, 'gemini-3.1-pro-preview');
  assert.equal(router.route({ taskType: 'fast' }).model, 'gpt-5-mini');
  assert.equal(router.route({ taskType: 'general' }).model, 'gpt-5-mini');
});

test('a large context requirement filters the chain', () => {
  const router = new MaestroModelRouter();
  const decision = router.route({ taskType: 'general', contextTokens: 500_000 });
  assert.ok(decision.chain.length >= 1);
  for (const id of decision.chain) assert.ok((getModel(id)?.contextWindow ?? 0) >= 500_000, id);
});

test('an unhealthy model drops out and the next one is used', () => {
  const router = new MaestroModelRouter();
  assert.equal(router.route({ taskType: 'code' }).model, 'claude-sonnet-4-6');
  router.updateHealth('claude-sonnet-4-6', false);
  const next = router.route({ taskType: 'code' });
  assert.equal(next.model, 'gpt-5');
  assert.ok(!next.chain.includes('claude-sonnet-4-6'));
});

test('fails closed when nothing satisfies the requirements', () => {
  const router = new MaestroModelRouter();
  assert.throws(() => router.route({ taskType: 'general', contextTokens: 5_000_000 }), /NO_HEALTHY_MODEL_FOR_REQUIREMENTS/);
});

/* -------------------------------------------------------------------------- */
/*  Fallback                                                                  */
/* -------------------------------------------------------------------------- */

test('runWithFallback tries models in order until one succeeds', async () => {
  const router = new MaestroModelRouter();
  const tried: string[] = [];
  const outcome = await router.runWithFallback(['claude-sonnet-4-6', 'gpt-5', 'gemini-3.1-pro-preview'], async (model) => {
    tried.push(model);
    if (model !== 'gemini-3.1-pro-preview') throw new Error(`DOWN:${model}`);
    return model;
  });
  assert.deepEqual(tried, ['claude-sonnet-4-6', 'gpt-5', 'gemini-3.1-pro-preview']);
  assert.equal(outcome.model, 'gemini-3.1-pro-preview');
  assert.equal(outcome.provider, 'google');
  assert.equal(outcome.attempts.length, 3);
});

test('runWithFallback throws MAESTRO_ALL_MODELS_FAILED when every model fails', async () => {
  const router = new MaestroModelRouter();
  await assert.rejects(() => router.runWithFallback(['gpt-5', 'claude-sonnet-4-6'], async (model) => { throw new Error(`DOWN:${model}`); }), /MAESTRO_ALL_MODELS_FAILED/);
});

/* -------------------------------------------------------------------------- */
/*  Maestro wiring                                                            */
/* -------------------------------------------------------------------------- */

test('orderProviders returns configured providers in chain order', () => {
  const router = new MaestroModelRouter();
  const providers = [new FakeProvider('openai'), new FakeProvider('anthropic'), new FakeProvider('google')];
  const ordered = router.orderProviders(router.chain('code'), providers);
  assert.deepEqual(ordered.map((provider) => provider.id), ['anthropic', 'openai', 'google']);
});

test('routeForOrchestrator hands the Maestro a model plus ordered providers', () => {
  const router = new MaestroModelRouter();
  const providers = [new FakeProvider('google'), new FakeProvider('openai'), new FakeProvider('anthropic')];
  const routed = router.routeForOrchestrator({ goal: 'Fix the bug in this function', providers });
  assert.equal(routed.taskType, 'code');
  assert.equal(routed.model, 'claude-sonnet-4-6');
  assert.equal(routed.providers[0]?.id, 'anthropic');
});

test('createRoutedProvider routes by task type and falls back across providers', async () => {
  const router = new MaestroModelRouter();
  const anthropic = new FakeProvider('anthropic', true);
  const openai = new FakeProvider('openai');
  const google = new FakeProvider('google');
  const routed = router.createRoutedProvider({ providers: [anthropic, openai, google], taskType: 'code' });
  const result = await routed.complete({ model: 'ignored', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(anthropic.requests[0]?.model, 'claude-sonnet-4-6');
  assert.equal(openai.requests[0]?.model, 'gpt-5');
  assert.equal(result.model, 'gpt-5');
  assert.equal(google.requests.length, 0);
});

test('createRoutedProvider requires providers', () => {
  const router = new MaestroModelRouter();
  assert.throws(() => router.createRoutedProvider({ providers: [] }), /ROUTED_PROVIDER_REQUIRES_PROVIDERS/);
});

test('every router model id exists in the catalog', () => {
  assert.deepEqual(validateTaskTypeModels(), []);
  for (const chain of Object.values(TASK_TYPE_MODELS)) assert.ok(chain.length >= 3);
});

/* -------------------------------------------------------------------------- */
/*  Health isolation between independent runs / tenants                       */
/* -------------------------------------------------------------------------- */

test('fork() returns an independent router with the same routing policy', () => {
  const base = new MaestroModelRouter();
  const fork = base.fork();
  assert.ok(fork instanceof MaestroModelRouter);
  assert.notEqual(fork, base);
  for (const taskType of TASK_TYPES) {
    assert.equal(fork.route({ taskType }).model, base.route({ taskType }).model);
    assert.deepEqual(fork.chain(taskType), base.chain(taskType));
  }
});

test('a failure in one run\'s forked router never poisons another run (isolation)', async () => {
  const base = new MaestroModelRouter();

  const run1 = base.fork();
  const run1Chain = run1.chain('code');
  assert.equal(run1Chain[0], 'claude-sonnet-4-6');
  const outcome = await run1.runWithFallback(run1Chain, async (model) => {
    if (model === 'claude-sonnet-4-6') throw new Error(`DOWN:${model}`);
    return { text: 'ok', model };
  });
  assert.equal(outcome.model, 'gpt-5', 'run 1 falls through to its next model');
  assert.equal(run1.route({ taskType: 'code' }).model, 'gpt-5', 'run 1 remembers the outage');

  const run2 = base.fork();
  assert.equal(run2.route({ taskType: 'code' }).model, 'claude-sonnet-4-6', 'run 2 still starts from the preferred model');
  assert.equal(base.route({ taskType: 'code' }).model, 'claude-sonnet-4-6', 'the base router is untouched');
});

test('two tenants forked from the same base are isolated from each other', () => {
  const base = new MaestroModelRouter();
  const tenantA = base.fork();
  const tenantB = base.fork();
  tenantA.updateHealth('gpt-5-mini', false);
  assert.equal(tenantB.route({ taskType: 'general' }).model, 'gpt-5-mini');
  assert.equal(base.route({ taskType: 'general' }).model, 'gpt-5-mini');
  assert.notEqual(tenantA.route({ taskType: 'general' }).model, 'gpt-5-mini');
});

test('fork({ shareHealth: true }) opts back into a shared circuit breaker', () => {
  const base = new MaestroModelRouter();
  const shared = base.fork({ shareHealth: true });
  shared.updateHealth('claude-sonnet-4-6', false);
  assert.equal(base.route({ taskType: 'code' }).model, 'gpt-5', 'the shared map is visible to the base');
  assert.equal(base.fork().route({ taskType: 'code' }).model, 'claude-sonnet-4-6', 'an isolated fork is unaffected');
});

test('updateHealth on a fork does not leak into the base health map', () => {
  const base = new MaestroModelRouter();
  const fork = base.fork();
  fork.updateHealth('gpt-5', false);
  assert.equal(base.route({ taskType: 'reasoning' }).model, 'gpt-5');
  assert.notEqual(fork.route({ taskType: 'reasoning' }).model, 'gpt-5');
});
