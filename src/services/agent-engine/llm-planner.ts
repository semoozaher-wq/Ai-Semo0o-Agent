import type { ChatCompletionMessage, TokenUsage } from '../../types/model';
import type { Plan, PlanStep, StepKind } from '../../types/task';
import type { ToolDefinition } from '../../types/tool';
import { uid } from '../../utils/id';
import type { LLMProvider } from '../ai/provider';

const STEP_KINDS: StepKind[] = [
  'reason',
  'tool',
  'search',
  'code',
  'write',
  'analyze',
  'verify',
  'reflect',
];

const MAX_PLAN_STEPS = 20;

export const PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PLAN_STEPS,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          kind: { type: 'string', enum: STEP_KINDS },
          dependsOn: { type: 'array', items: { type: 'string' } },
          toolId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          // Strict JSON Schema cannot safely describe arbitrary tool-specific keys.
          // The planner therefore returns a JSON object encoded as a string.
          toolArgs: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['title', 'description', 'kind', 'dependsOn', 'toolId', 'toolArgs'],
        additionalProperties: false,
      },
    },
  },
  required: ['reasoning', 'steps'],
  additionalProperties: false,
} as const;

export interface LLMPlannerOptions {
  model: string;
  providers: LLMProvider[];
  tools: ToolDefinition[];
  context?: string;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMPlanResult {
  plan: Plan;
  providerId: string;
  usage: TokenUsage;
  latencyMs: number;
  attempts: { providerId: string; error?: string }[];
}

interface RawPlanStep {
  title?: unknown;
  description?: unknown;
  kind?: unknown;
  dependsOn?: unknown;
  toolId?: unknown;
  toolArgs?: unknown;
}

interface RawPlan {
  reasoning?: unknown;
  steps?: unknown;
}

function plannerMessages(goal: string, tools: ToolDefinition[], context?: string): ChatCompletionMessage[] {
  const catalog = tools.map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description,
    dangerous: Boolean(tool.dangerous),
    parameters: tool.parameters,
  }));

  return [
    {
      role: 'system',
      content:
        'أنت مخطط مهام لمنصة Semo0o AI. افهم الهدف ثم أخرج JSON فقط مطابقًا للمخطط المطلوب. لا تنفذ الأدوات ولا تدّعي نجاحًا. اجعل الخطوات قابلة للتحقق. استخدم toolId فقط من الكتالوج، واجعل dependsOn تشير إلى معرفات الخطوات التي ستنشئها بصيغة step-1 وstep-2 حسب ترتيبها.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        goal,
        context: context ?? '',
        availableTools: catalog,
        outputContract: {
          reasoning: 'سبب مختصر للخطة',
          steps: [
            {
              title: 'عنوان واضح',
              description: 'ما الذي يجب فعله وكيف نعرف أنه انتهى',
              kind: 'reason|tool|search|code|write|analyze|verify|reflect',
              dependsOn: ['step-1'],
              toolId: 'tool.id أو null',
              toolArgs: 'نص JSON لكائن المعاملات أو null',
            },
          ],
        },
      }),
    },
  ];
}

function extractJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('PLANNER_INVALID_JSON');
  }
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`PLANNER_INVALID_${field.toUpperCase()}`);
  return value.trim();
}

function assertStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`PLANNER_INVALID_${field.toUpperCase()}`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function validateAcyclic(steps: PlanStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('PLANNER_CYCLIC_DEPENDENCY');
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step) throw new Error(`PLANNER_UNKNOWN_DEPENDENCY:${id}`);
    visiting.add(id);
    step.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  steps.forEach((step) => visit(step.id));
}

function normalizePlan(raw: unknown, goal: string, tools: ToolDefinition[]): Plan {
  if (!raw || typeof raw !== 'object') throw new Error('PLANNER_INVALID_RESPONSE');
  const document = raw as RawPlan;
  if (!Array.isArray(document.steps) || document.steps.length === 0 || document.steps.length > MAX_PLAN_STEPS) {
    throw new Error('PLANNER_INVALID_STEP_COUNT');
  }

  const availableTools = new Set(tools.map((tool) => tool.id));
  const steps: PlanStep[] = document.steps.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`PLANNER_INVALID_STEP:${index}`);
    const step = value as RawPlanStep;
    const kind = assertString(step.kind, `step_${index}_kind`) as StepKind;
    if (!STEP_KINDS.includes(kind)) throw new Error(`PLANNER_UNKNOWN_STEP_KIND:${kind}`);
    const toolId = step.toolId == null ? undefined : assertString(step.toolId, `step_${index}_tool_id`);
    if (toolId && !availableTools.has(toolId)) throw new Error(`PLANNER_UNKNOWN_TOOL:${toolId}`);
    let toolArgs: unknown = step.toolArgs == null ? undefined : step.toolArgs;
    if (typeof toolArgs === 'string') {
      try {
        toolArgs = JSON.parse(toolArgs);
      } catch {
        throw new Error(`PLANNER_INVALID_TOOL_ARGS:${index}`);
      }
    }
    if (toolArgs !== undefined && (typeof toolArgs !== 'object' || Array.isArray(toolArgs) || toolArgs === null)) {
      throw new Error(`PLANNER_INVALID_TOOL_ARGS:${index}`);
    }
    return {
      id: `step-${index + 1}`,
      index,
      kind,
      title: assertString(step.title, `step_${index}_title`),
      description: assertString(step.description, `step_${index}_description`),
      dependsOn: assertStringArray(step.dependsOn, `step_${index}_dependencies`),
      status: 'pending',
      ...(toolId ? { toolId } : {}),
      ...(toolArgs ? { toolArgs: toolArgs as Record<string, unknown> } : {}),
    } as PlanStep;
  });

  const ids = new Set(steps.map((step) => step.id));
  steps.forEach((step) => {
    if (step.dependsOn.some((dependency) => !ids.has(dependency))) {
      throw new Error(`PLANNER_UNKNOWN_DEPENDENCY:${step.id}`);
    }
    if (step.dependsOn.includes(step.id)) throw new Error(`PLANNER_SELF_DEPENDENCY:${step.id}`);
  });
  validateAcyclic(steps);

  return {
    id: uid('plan'),
    goal,
    createdAt: new Date().toISOString(),
    steps,
    reasoning: assertString(document.reasoning, 'reasoning'),
  };
}

export class LLMPlanner {
  async plan(goal: string, options: LLMPlannerOptions): Promise<LLMPlanResult> {
    if (!goal.trim()) throw new Error('PLANNER_GOAL_REQUIRED');
    if (options.providers.length === 0) throw new Error('PLANNER_PROVIDER_REQUIRED');

    const attempts: LLMPlanResult['attempts'] = [];
    for (const provider of options.providers) {
      const started = Date.now();
      try {
        const result = await provider.complete({
          model: options.model,
          messages: plannerMessages(goal, options.tools, options.context),
          maxTokens: options.maxTokens ?? 4_096,
          responseFormat: {
            type: 'json_schema',
            jsonSchema: {
              name: 'semo0o_agent_plan',
              strict: true,
              schema: PLAN_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
            },
          },
          signal: options.signal,
        });
        const plan = normalizePlan(extractJson(result.content), goal, options.tools);
        return {
          plan,
          providerId: provider.id,
          usage: result.usage,
          latencyMs: Date.now() - started,
          attempts: [...attempts, { providerId: provider.id }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        attempts.push({ providerId: provider.id, error: message });
      }
    }

    throw new Error(`PLANNER_ALL_PROVIDERS_FAILED:${attempts.map((attempt) => `${attempt.providerId}:${attempt.error}`).join('|')}`);
  }
}

export const llmPlanner = new LLMPlanner();
