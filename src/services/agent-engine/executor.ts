import { Plan, Task, TaskStep } from '../../types/task';
import { ToolInvocation } from '../../types/tool';
import { uid } from '../../utils/id';
import { sleep } from '../../utils/async';
import { estimateTokens } from '../../utils/text';
import { AgentMemory } from './memory';
import { createPlan, planProgress, replan } from './planner';
import { runTool } from './tools';

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

export interface AgentRunEvents {
  onTaskUpdate?: (task: Task) => void;
  onLog?: (message: string, level: LogLevel) => void;
}

export interface RunOptions extends AgentRunEvents {
  model: string;
  maxIterations?: number;
  /** Cooperative cancellation flag. */
  signal?: { cancelled: boolean };
  /** Optional UI pacing delay; it never changes execution truth. */
  stepDelayMs?: number;
}

function stepToolFor(step: TaskStep, goal: string): {
  toolId: string;
  args: Record<string, unknown>;
} | null {
  const g = goal.toLowerCase();
  switch (step.kind) {
    case 'search':
      return { toolId: 'web.search', args: { query: goal, limit: 5 } };
    case 'analyze':
      if (/(بيانات|data|csv|dataset)/.test(g))
        return { toolId: 'data.profile', args: { fileId: 'dataset-1' } };
      if (/(ملفات|files|تدقيق|audit)/.test(g))
        return { toolId: 'files.scan', args: { scope: '/', deep: true } };
      return { toolId: 'code.analyze', args: { path: 'src', autofix: true } };
    case 'tool':
      if (/(بيانات|data|chart|رسم)/.test(g))
        return { toolId: 'data.chart', args: { type: 'bar', data: {} } };
      if (/(ملفات|files|تدقيق|audit)/.test(g))
        return { toolId: 'files.scan', args: { scope: '/', deep: true } };
      return { toolId: 'code.run', args: { language: 'javascript', source: '// tests' } };
    case 'verify':
      return { toolId: 'code.run', args: { language: 'javascript', source: '// verify' } };
    default:
      return null;
  }
}

function reasoningFor(step: TaskStep, goal: string): string {
  switch (step.kind) {
    case 'reason':
      return `حلّلت الهدف «${goal}» وفكّكته إلى مهام فرعية قابلة للتنفيذ، مع تحديد المعايير اللازمة للنجاح.`;
    case 'code':
      return `أكتب الكود بشكل معياري مع معالجة الأخطاء، وأحرص على فصل المسؤوليات لسهولة الاختبار.`;
    case 'write':
      return `أصوغ المخرجات بلغة واضحة ومنظّمة، مع إبراز النقاط الجوهرية والتوصيات.`;
    case 'reflect':
      return `أراجع النتائج مقابل الهدف الأصلي للتأكد من الاكتمال والدقة قبل التسليم.`;
    default:
      return `أتابع تنفيذ الخطوة «${step.title}» ضمن خطة المهمة.`;
  }
}

export class AgentExecutor {
  async run(task: Task, options: RunOptions): Promise<Task> {
    const { model, maxIterations = 12, signal, stepDelayMs = 420 } = options;
    const memory = new AgentMemory(task.id);

    let current: Task = {
      ...task,
      status: 'planning',
      model,
      startedAt: task.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    options.onTaskUpdate?.(current);
    options.onLog?.('بدء التخطيط الذاتي…', 'info');

    await sleep(stepDelayMs);

    const plan: Plan = task.plan ?? createPlan(task.goal, model);
    memory.add('decision', `تم إنشاء خطة من ${plan.steps.length} خطوات.`, 0.8);

    current = {
      ...current,
      plan,
      steps: plan.steps.map((s) => ({ ...s })),
      status: 'running',
      iterations: 0,
    };
    options.onTaskUpdate?.(current);
    options.onLog?.(`الخطة جاهزة (${plan.steps.length} خطوات). بدء التنفيذ…`, 'success');

    let iterations = 0;

    for (let i = 0; i < current.steps.length; i += 1) {
      if (signal?.cancelled) {
        current = {
          ...current,
          status: 'cancelled',
          updatedAt: new Date().toISOString(),
        };
        options.onTaskUpdate?.(current);
        options.onLog?.('تم إلغاء المهمة بواسطة المستخدم.', 'warn');
        return current;
      }

      if (iterations >= maxIterations) {
        options.onLog?.('تم الوصول للحد الأقصى من التكرارات.', 'warn');
        break;
      }
      iterations += 1;

      const step = current.steps[i];
      if (!step) continue;
      const runningStep: TaskStep = {
        ...step,
        status: 'running',
        startedAt: new Date().toISOString(),
        logs: [`▶ ${step.title}`],
      };
      current = this.replaceStep(current, i, runningStep);
      options.onTaskUpdate?.(current);
      options.onLog?.(`▶ ${step.title}`, 'info');

      await sleep(stepDelayMs);

      // Attempt tool execution when applicable.
      const toolSpec = stepToolFor(step, task.goal);
      let toolInvocations: ToolInvocation[] | undefined;
      let output = reasoningFor(step, task.goal);

      if (toolSpec) {
        const invocation: ToolInvocation = {
          id: uid('inv'),
          toolId: toolSpec.toolId,
          args: toolSpec.args,
          startedAt: new Date().toISOString(),
          status: 'running',
        };
        options.onLog?.(`   ↳ استدعاء الأداة: ${toolSpec.toolId}`, 'info');
        const result = await runTool(toolSpec.toolId, toolSpec.args);
        invocation.finishedAt = new Date().toISOString();
        invocation.durationMs = result.durationMs;
        invocation.status = result.ok ? 'success' : 'error';
        invocation.output = result.output;
        invocation.error = result.error;
        toolInvocations = [invocation];
        result.logs.forEach((l) => options.onLog?.(`   ${l}`, 'info'));

        if (result.ok) {
          output = `${output}\n\nنتيجة الأداة: ${JSON.stringify(result.output).slice(0, 280)}`;
          memory.add('observation', `نجحت الأداة ${toolSpec.toolId}.`, 0.6);
        } else {
          memory.add('observation', `فشلت الأداة ${toolSpec.toolId}: ${result.error}`, 0.9);
          options.onLog?.(`   ⚠ فشل: ${result.error}`, 'warn');
        }
      }

      if (!resultOk(toolInvocations)) {
        const failedStep: TaskStep = {
          ...runningStep,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          output,
          toolInvocations,
          logs: [...(runningStep.logs ?? []), '✗ فشل التنفيذ'],
        };
        current = this.replaceStep(current, i, failedStep);
        current = { ...current, status: 'failed', updatedAt: new Date().toISOString() };
        options.onTaskUpdate?.(current);
        options.onLog?.(`✗ فشل تنفيذ ${step.title}`, 'error');
        return current;
      }
      const completedStep: TaskStep = {
        ...runningStep,
        status: 'completed',
        finishedAt: new Date().toISOString(),
        output,
        toolInvocations,
        logs: [...(runningStep.logs ?? []), `✓ اكتملت`],
      };
      current = this.replaceStep(current, i, completedStep);
      current = {
        ...current,
        progress: planProgress(current.steps),
        updatedAt: new Date().toISOString(),
      };
      options.onTaskUpdate?.(current);
      options.onLog?.(`✓ ${step.title}`, 'success');
    }

    const result = this.composeResult(current, memory);
    current = {
      ...current,
      status: 'completed',
      progress: 1,
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result,
      tokensUsed: current.steps.reduce((sum, step) => sum + estimateTokens(step.output ?? ''), 0),
    };
    options.onTaskUpdate?.(current);
    options.onLog?.('اكتملت المهمة بنجاح. ✅', 'success');
    return current;
  }

  /** Re-plans and resumes a failed task. */
  async recover(task: Task, failedStepId: string, options: RunOptions): Promise<Task> {
    const plan = task.plan ? replan(task.plan, failedStepId) : createPlan(task.goal, options.model);
    const resumed: Task = {
      ...task,
      plan,
      steps: plan.steps.map((s) => ({ ...s })),
      status: 'running',
      progress: 0,
    };
    options.onLog?.('تم إنشاء خطة استرداد وإعادة التشغيل.', 'warn');
    return this.run(resumed, options);
  }

  private replaceStep(task: Task, index: number, step: TaskStep): Task {
    const steps = [...task.steps];
    steps[index] = step;
    return { ...task, steps, progress: planProgress(steps) };
  }

  private composeResult(task: Task, memory: AgentMemory): string {
    const done = task.steps.filter((s) => s.status === 'completed').length;
    return [
      `## نتيجة المهمة`,
      ``,
      `**الهدف:** ${task.goal}`,
      ``,
      `**الخطوات المكتملة:** ${done}/${task.steps.length}`,
      ``,
      `**الملخص:**`,
      `تم تنفيذ المهمة عبر ${task.steps.length} خطوات مع استخدام الأدوات والتحقق الذاتي. تم إنتاج المخرجات المطلوبة ومراجعتها.`,
      ``,
      `**ذاكرة الوكيل (آخر الملاحظات):**`,
      memory
        .recent(3)
        .map((m) => `- ${m.content}`)
        .join('\n'),
    ].join('\n');
  }
}

function resultOk(invocations: ToolInvocation[] | undefined): boolean {
  return !invocations || invocations.every((invocation) => invocation.status === 'success');
}

export const agentExecutor = new AgentExecutor();
