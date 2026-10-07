import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOLS } from '../src/data/tools';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResult,
} from '../src/types/model';
import type { LLMProvider } from '../src/services/ai/provider';
import { LLMPlanner } from '../src/services/agent-engine/llm-planner';
import { AgentOrchestrator } from '../src/services/agent-engine/orchestrator';
import { registerTool, unregisterTool } from '../src/services/agent-engine/tools';
import { RECOVERY_EVENTS } from '../src/services/agent-engine/verification';

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

function singleVerificationPlan(): string {
  return JSON.stringify({
    reasoning: 'تنفيذ ثم تحقق بالدليل.',
    steps: [{
      title: 'تنفيذ قابل للتحقق',
      description: 'تنفيذ أداة حقيقية والتحقق من ناتجها.',
      kind: 'verify',
      dependsOn: [],
      toolId: 'code.run',
      toolArgs: { language: 'javascript', source: 'return 1' },
    }],
  });
}

test('LLM planner requests strict JSON and normalizes a validated plan', async () => {
  const provider = new DeterministicProvider(planJson);
  const result = await new LLMPlanner().plan('افحص المشروع ثم تحقق منه', {
    model: 'gpt-5',
    providers: [provider],
    tools,
  });

  assert.equal(result.plan.steps.length, 2);
  assert.equal(result.plan.steps[1]?.dependsOn[0], 'step-1');
  assert.equal(result.plan.steps[0]?.toolId, 'code.analyze');
  assert.equal(provider.requests[0]?.responseFormat?.jsonSchema.name, 'semo0o_agent_plan');
  assert.equal(provider.requests[0]?.responseFormat?.jsonSchema.strict, true);
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
  assert.match(result.attempts[0]?.error ?? '', /PROVIDER_UNAVAILABLE/);
});

test('orchestrator never reports verified success for unavailable tools', async () => {
  const provider = new DeterministicProvider(planJson);
  const result = await new AgentOrchestrator().run({
    goal: 'افحص المشروع ثم تحقق منه',
    model: 'gpt-5',
    providers: [provider],
    tools,
    requestPermission: async () => true,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0]?.ok, false);
  assert.match(result.outputs[0]?.error ?? '', /لا يوجد تنفيذ للأداة/);
  assert.ok(result.errors.some((error) => /لا يوجد تنفيذ للأداة/.test(error)));
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

test('verification gate marks real output with evidence as completed', async () => {
  registerTool('code.run', async () => ({ output: { value: 1 } }));
  try {
    const result = await new AgentOrchestrator().run({ goal: 'نفذ وتحقق', model: 'gpt-5', providers: [new DeterministicProvider(singleVerificationPlan())], tools, requestPermission: async () => true });
    assert.equal(result.status, 'completed');
    assert.equal(result.verifications.at(-1)?.status, 'VERIFIED');
    assert.equal(result.evidence.length, 1);
  } finally {
    unregisterTool('code.run');
  }
});

test('orchestrator emits live planning, step, tool, and verification events', async () => {
  registerTool('code.run', async () => ({ output: { value: 2 } }));
  const events: string[] = [];
  try {
    await new AgentOrchestrator().run({
      goal: 'نفذ مع Timeline',
      model: 'gpt-5',
      providers: [new DeterministicProvider(singleVerificationPlan())],
      tools,
      requestPermission: async () => true,
      onEvent: (next) => events.push(next.type),
    });
    assert.equal(events[0], 'planning_started');
    assert.ok(events.includes('planning_completed'));
    assert.ok(events.includes('step_started'));
    assert.ok(events.includes('tool_completed'));
    assert.ok(events.includes('step_completed'));
  } finally {
    unregisterTool('code.run');
  }
});

test('false tool success cannot become completed when verification fails', async () => {
  registerTool('code.run', async () => ({ output: { claimed: true } }));
  try {
    const result = await new AgentOrchestrator().run({
      goal: 'تحقق من النتيجة', model: 'gpt-5', providers: [new DeterministicProvider(singleVerificationPlan())], tools,
      requestPermission: async () => true,
      verifyStep: async () => ({ status: 'FAILED', criteria: [], evidenceIds: [], summary: 'actual result disagrees', failureKind: 'VALIDATION_FAILURE', verifiedAt: new Date().toISOString() }),
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(result.verifications.at(-1)?.status, 'FAILED');
  } finally {
    unregisterTool('code.run');
  }
});

test('execution failure invokes self-healing and succeeds on a bounded retry', async () => {
  let calls = 0;
  registerTool('code.run', async () => {
    calls += 1;
    if (calls === 1) throw new Error('execution timeout');
    return { output: { fixed: true } };
  });
  try {
    const result = await new AgentOrchestrator().run({
      goal: 'أصلح ثم تحقق', model: 'gpt-5', providers: [new DeterministicProvider(singleVerificationPlan())], tools,
      requestPermission: async () => true,
      selfHeal: async ({ failureKind }) => { assert.equal(failureKind, 'EXECUTION_FAILURE'); return { action: 'retry' }; },
    });
    assert.equal(result.status, 'completed_with_warnings');
    assert.ok(result.warnings.some((warning) => warning.startsWith('SELF_HEALED:')));
    assert.equal(calls, 2);
  } finally {
    unregisterTool('code.run');
  }
});

test('self-healing emits the unified recovery event with {action, failureKind, attempt}', async () => {
  let calls = 0;
  registerTool('code.run', async () => {
    calls += 1;
    if (calls === 1) throw new Error('execution timeout');
    return { output: { fixed: true } };
  });
  try {
    const result = await new AgentOrchestrator().run({
      goal: 'أصلح ثم تحقق', model: 'gpt-5', providers: [new DeterministicProvider(singleVerificationPlan())], tools,
      requestPermission: async () => true,
      selfHeal: async () => ({ action: 'retry' }),
    });
    const healed = result.events.find((entry) => entry.type === RECOVERY_EVENTS.selfHealing);
    assert.ok(healed, 'a self_healing event must be emitted');
    assert.equal(healed?.type, 'self_healing');
    assert.deepEqual(healed?.details, { action: 'retry', failureKind: 'EXECUTION_FAILURE', attempt: 1 });
  } finally {
    unregisterTool('code.run');
  }
});

test('exhausted self-healing emits self_healing_failed with the bounded decision', async () => {
  let calls = 0;
  registerTool('code.run', async () => { calls += 1; throw new Error('tool unavailable'); });
  try {
    const result = await new AgentOrchestrator().run({
      goal: 'أعد المحاولة بحد', model: 'gpt-5', providers: [new DeterministicProvider(singleVerificationPlan())], tools, maxAttempts: 2,
      requestPermission: async () => true,
      selfHeal: async () => ({ action: 'retry' }),
    });
    const failed = result.events.find((entry) => entry.type === RECOVERY_EVENTS.selfHealingFailed);
    assert.ok(failed, 'a self_healing_failed event must be emitted when attempts are exhausted');
    assert.equal(failed?.details?.failureKind, 'TOOL_FAILURE');
    assert.equal(failed?.details?.attempt, 2);
    assert.equal(failed?.details?.reason, 'attempts_exhausted');
  } finally {
    unregisterTool('code.run');
  }
});

test('retry limit stops repeated failures without an infinite loop', async () => {
  let calls = 0;
  registerTool('code.run', async () => { calls += 1; throw new Error('tool unavailable'); });
  try {
    const result = await new AgentOrchestrator().run({
      goal: 'أعد المحاولة بحد', model: 'gpt-5', providers: [new DeterministicProvider(singleVerificationPlan())], tools, maxAttempts: 2,
      requestPermission: async () => true,
      selfHeal: async () => ({ action: 'retry' }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(calls, 2);
  } finally {
    unregisterTool('code.run');
  }
});

test('missing actual output is UNVERIFIED, not completed', async () => {
  registerTool('code.run', async () => ({ output: null }));
  try {
    const result = await new AgentOrchestrator().run({ goal: 'تحقق من دليل مفقود', model: 'gpt-5', providers: [new DeterministicProvider(singleVerificationPlan())], tools, requestPermission: async () => true });
    assert.equal(result.status, 'unverified');
  } finally {
    unregisterTool('code.run');
  }
});

test('simulated tool output cannot produce production verification evidence', async () => {
  registerTool('code.run', async () => ({ output: { demo: true }, simulated: true }));
  try {
    const result = await new AgentOrchestrator().run({ goal: 'لا تعتمد المحاكاة', model: 'gpt-5', providers: [new DeterministicProvider(singleVerificationPlan())], tools, requestPermission: async () => true });
    assert.equal(result.status, 'failed');
    assert.equal(result.evidence[0]?.simulated, true);
    assert.equal(result.verifications[0]?.status, 'FAILED');
  } finally {
    unregisterTool('code.run');
  }
});
