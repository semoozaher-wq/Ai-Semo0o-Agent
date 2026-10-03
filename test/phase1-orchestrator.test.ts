import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOLS } from '../data/tools';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResult,
} from '../src/types/model';
import type { LLMProvider } from '../src/services/ai/provider';
import { LLMPlanner } from '../src/services/agent-engine/llm-planner';
import { AgentOrchestrator } from '../src/services/agent-engine/orchestrator';

const usage = { promptTokens: 40, completionTokens: 30, totalTokens: 70 };

class DeterministicProvider implements LLMProvider {
  readonly live = true;
  readonly id = 'openai' as const;
  requests: ChatCompletionRequest[] = [];

  constructor(
    private readonly content: string,
    private readonly shouldFail = false,
  ) {}

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.requests.push(request);
    if (this.shouldFail) throw new Error('PROVIDER_UNAVAILABLE');
    return {
      id: 'plan-1',
      model: request.model,
      content: this.content,
      usage,
      finishReason: 'stop',
    };
  }

  async *stream(_request: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    yield { id: 'unused', delta: '', done: true };
  }
}

const planJson = JSON.stringify({
  reasoning: 'أتحقق من المشروع ثم أشغل الاختبار وأراجع النتيجة.',
  steps: [
    {
      title: 'فحص المشروع',
      description: 'تشغيل تحليل آمن للمشروع.',
      kind: 'analyze',
      dependsOn: [],
      toolId: 'code.analyze',
      toolArgs: { path: 'src', autofix: false },
    },
    {
      title: 'التحقق النهائي',
      description: 'تشغيل تحقق نهائي قابل للإثبات.',
      kind: 'verify',
      dependsOn: ['step-1'],
      toolId: 'code.run',
      toolArgs: { language: 'javascript', source: 'process.exit(0)' },
    },
  ],
});

const tools = TOOLS.filter((tool) => ['code.analyze', 'code.run', 'email.send'].includes(tool.id));

test('LLM planner requests strict JSON and normalizes a validated plan', async () => {
  const provider = new DeterministicProvider(planJson);
  const result = await new LLMPlanner().plan('افحص المشروع ثم تحقق منه', {
    model: 'gpt-5',
    providers: [provider],
    tools,
  });

  assert.equal(result.plan.steps.length, 2);
  assert.equal(result.plan.steps[1].dependsOn[0], 'step-1');
  assert.equal(result.plan.steps[0].toolId, 'code.analyze');
  assert.equal(provider.requests[0].responseFormat?.jsonSchema.name, 'semo0o_agent_plan');
  assert.equal(provider.requests[0].responseFormat?.jsonSchema.strict, true);
});

test('LLM planner falls back to the next provider and records the failed attempt', async () => {
  const failed = new DeterministicProvider(planJson, true);
  const working = new DeterministicProvider(planJson);
  const result = await new LLMPlanner().plan('تحقق من المشروع', {
    model: 'gpt-5',
    providers: [failed, working],
    tools,
  });

  assert.equal(result.providerId, 'openai');
  assert.equal(result.attempts.length, 2);
  assert.match(result.attempts[0].error ?? '', /PROVIDER_UNAVAILABLE/);
});

test('orchestrator never reports verified success for simulated tools', async () => {
  const provider = new DeterministicProvider(planJson);
  const result = await new AgentOrchestrator().run({
    goal: 'افحص المشروع ثم تحقق منه',
    model: 'gpt-5',
    providers: [provider],
    tools,
    requestPermission: async () => true,
  });

  assert.equal(result.status, 'completed_with_warnings');
  assert.ok(result.warnings.includes('SIMULATED_TOOL_RESULT:code.run'));
  assert.equal(result.outputs.length, 2);
  assert.equal(result.outputs.every((output) => output.simulated), true);
  assert.ok(result.costUsd > 0);
});

test('orchestrator blocks dangerous tools without explicit permission', async () => {
  const dangerousPlan = JSON.stringify({
    reasoning: 'إرسال البريد يحتاج موافقة صريحة.',
    steps: [{
      title: 'إرسال البريد',
      description: 'تنفيذ العملية بعد موافقة المستخدم.',
      kind: 'tool',
      dependsOn: [],
      toolId: 'email.send',
      toolArgs: { to: 'user@example.test', subject: 'Test', body: 'Test' },
    }],
  });
  const provider = new DeterministicProvider(dangerousPlan);
  const result = await new AgentOrchestrator().run({
    goal: 'أرسل بريدًا',
    model: 'gpt-5',
    providers: [provider],
    tools,
    requestPermission: async () => false,
  });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.outputs, []);
  assert.ok(result.errors.includes('PERMISSION_DENIED:email.send'));
});

test('planner rejects unknown tools and cyclic dependencies before execution', async () => {
  const invalid = new DeterministicProvider(JSON.stringify({
    reasoning: 'خطة غير صالحة.',
    steps: [{
      title: 'خطوة',
      description: 'لا ينبغي تنفيذها.',
      kind: 'tool',
      dependsOn: ['step-2'],
      toolId: 'unknown.tool',
      toolArgs: {},
    }],
  }));

  await assert.rejects(
    () => new LLMPlanner().plan('طلب', { model: 'gpt-5', providers: [invalid], tools }),
    /PLANNER_UNKNOWN_TOOL|PLANNER_UNKNOWN_DEPENDENCY/,
  );
});
