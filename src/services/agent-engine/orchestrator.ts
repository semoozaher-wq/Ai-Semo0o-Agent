import type { LLMProvider } from '../ai/provider';
import { aiService } from '../ai/runtime';
import { getTool } from '../../data/tools';
import type { Plan, PlanStep } from '../../types/task';
import type { ToolDefinition } from '../../types/tool';
import { runTool } from './tools';
import { LLMPlanner, type LLMPlanResult } from './llm-planner';

export type OrchestratorStatus =
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'unverified';

export interface OrchestratorEvent {
  at: string;
  type:
    | 'planning_started'
    | 'planning_completed'
    | 'planning_failed'
    | 'permission_requested'
    | 'step_started'
    | 'tool_completed'
    | 'step_completed'
    | 'verification_required'
    | 'run_finished';
  stepId?: string;
  toolId?: string;
  details?: Record<string, unknown>;
}

export interface OrchestratorInput {
  goal: string;
  model: string;
  providers: LLMProvider[];
  tools?: ToolDefinition[];
  context?: string;
  signal?: { cancelled: boolean };
  maxSteps?: number;
  /** Dangerous tools are blocked unless this callback explicitly allows them. */
  requestPermission?: (request: {
    tool: ToolDefinition;
    step: PlanStep;
  }) => boolean | Promise<boolean>;
}

export interface OrchestratorResult {
  status: OrchestratorStatus;
  plan?: Plan;
  planner?: Pick<LLMPlanResult, 'providerId' | 'usage' | 'latencyMs' | 'attempts'>;
  events: OrchestratorEvent[];
  outputs: {
    stepId: string;
    toolId?: string;
    ok: boolean;
    simulated: boolean;
    output: unknown;
    error?: string;
    durationMs?: number;
  }[];
  warnings: string[];
  errors: string[];
  usage: LLMPlanResult['usage'];
  costUsd: number;
}

const emptyUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function event(type: OrchestratorEvent['type'], details?: Record<string, unknown>, stepId?: string, toolId?: string): OrchestratorEvent {
  return { at: new Date().toISOString(), type, details, stepId, toolId };
}

function mergeUsage(left: LLMPlanResult['usage'], right: LLMPlanResult['usage']): LLMPlanResult['usage'] {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export class AgentOrchestrator {
  constructor(private readonly planner: LLMPlanner = new LLMPlanner()) {}

  async run(input: OrchestratorInput): Promise<OrchestratorResult> {
    const events: OrchestratorEvent[] = [event('planning_started')];
    const outputs: OrchestratorResult['outputs'] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const tools = input.tools ?? [];
    const maxSteps = Math.max(1, Math.min(input.maxSteps ?? 20, 20));

    let planned: LLMPlanResult;
    try {
      planned = await this.planner.plan(input.goal, {
        model: input.model,
        providers: input.providers,
        tools,
        context: input.context,
        signal: undefined,
      });
      events.push(event('planning_completed', {
        providerId: planned.providerId,
        steps: planned.plan.steps.length,
        latencyMs: planned.latencyMs,
        attempts: planned.attempts,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      events.push(event('planning_failed', { error: message }));
      return {
        status: 'failed',
        events: [...events, event('run_finished', { status: 'failed' })],
        outputs,
        warnings,
        errors,
        usage: emptyUsage,
        costUsd: 0,
      };
    }

    const plan = planned.plan;
    if (plan.steps.length > maxSteps) {
      const message = `PLAN_STEP_LIMIT_EXCEEDED:${plan.steps.length}`;
      errors.push(message);
      return {
        status: 'failed',
        plan,
        planner: planned,
        events: [...events, event('run_finished', { status: 'failed' })],
        outputs,
        warnings,
        errors,
        usage: planned.usage,
        costUsd: aiService.estimateCostUsd(input.model, planned.usage),
      };
    }

    let usage = planned.usage;
    let hasExecutableStep = false;
    let hasVerification = false;

    for (const step of plan.steps) {
      if (input.signal?.cancelled) {
        warnings.push('RUN_CANCELLED_BY_USER');
        return this.finish('cancelled', plan, planned, events, outputs, warnings, errors, usage, input.model);
      }

      events.push(event('step_started', { title: step.title, kind: step.kind }, step.id, step.toolId));
      if (step.kind === 'verify') hasVerification = true;
      if (!step.toolId) {
        events.push(event('step_completed', { verified: false, reason: 'no_tool' }, step.id));
        continue;
      }

      hasExecutableStep = true;
      const tool = getTool(step.toolId);
      if (!tool) {
        errors.push(`UNKNOWN_TOOL:${step.toolId}`);
        events.push(event('tool_completed', { ok: false, simulated: false, error: 'UNKNOWN_TOOL' }, step.id, step.toolId));
        return this.finish('failed', plan, planned, events, outputs, warnings, errors, usage, input.model);
      }

      if (tool.dangerous) {
        events.push(event('permission_requested', { dangerous: true }, step.id, tool.id));
        const allowed = await input.requestPermission?.({ tool, step }) ?? false;
        if (!allowed) {
          const message = `PERMISSION_DENIED:${tool.id}`;
          errors.push(message);
          return this.finish('blocked', plan, planned, events, outputs, warnings, errors, usage, input.model);
        }
      }

      const result = await runTool(step.toolId, step.toolArgs ?? {});
      outputs.push({
        stepId: step.id,
        toolId: step.toolId,
        ok: result.ok,
        simulated: false,
        output: result.output,
        error: result.error,
        durationMs: result.durationMs,
      });
      events.push(event('tool_completed', {
        ok: result.ok,
        simulated: false,
        durationMs: result.durationMs,
        error: result.error,
      }, step.id, step.toolId));

      if (!result.ok) {
        errors.push(result.error ?? `TOOL_FAILED:${step.toolId}`);
        return this.finish('failed', plan, planned, events, outputs, warnings, errors, usage, input.model);
      }
      events.push(event('step_completed', { verified: true }, step.id, step.toolId));
    }

    if (!hasExecutableStep || !hasVerification) {
      events.push(event('verification_required', { hasExecutableStep, hasVerification }));
      warnings.push('NO_REAL_VERIFICATION_STEP');
      return this.finish('unverified', plan, planned, events, outputs, warnings, errors, usage, input.model);
    }
    return this.finish('completed', plan, planned, events, outputs, warnings, errors, usage, input.model);
  }

  private finish(
    status: OrchestratorStatus,
    plan: Plan,
    planned: LLMPlanResult,
    events: OrchestratorEvent[],
    outputs: OrchestratorResult['outputs'],
    warnings: string[],
    errors: string[],
    usage: LLMPlanResult['usage'],
    model: string,
  ): OrchestratorResult {
    const result = {
      status,
      plan,
      planner: planned,
      events: [...events, event('run_finished', { status })],
      outputs,
      warnings,
      errors,
      usage: mergeUsage(emptyUsage, usage),
      costUsd: aiService.estimateCostUsd(model, usage),
    };
    return result;
  }
}

export const agentOrchestrator = new AgentOrchestrator();
