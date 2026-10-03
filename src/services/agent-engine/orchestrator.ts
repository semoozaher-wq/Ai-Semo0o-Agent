import type { LLMProvider } from '../ai/provider';
import { aiService } from '../ai/runtime';
import { getTool } from '../../data/tools';
import type { Plan, PlanStep } from '../../types/task';
import type { ToolDefinition } from '../../types/tool';
import { runTool } from './tools';
import { LLMPlanner, type LLMPlanResult } from './llm-planner';
import {
  classifyFailure,
  verifyEvidence,
  type Evidence,
  type FailureKind,
  type VerificationResult,
} from './verification';

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
  taskId?: string;
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
  maxAttempts?: number;
  verifyStep?: (input: {
    step: PlanStep;
    output: unknown;
    evidence: Evidence[];
  }) => VerificationResult | Promise<VerificationResult>;
  selfHeal?: (input: {
    step: PlanStep;
    failureKind: FailureKind;
    verification: VerificationResult;
    evidence: Evidence[];
    attempt: number;
  }) => Promise<{ action: 'retry' | 'repair' | 'replan' | 'block'; toolArgs?: Record<string, unknown> } | undefined>;
  onEvent?: (event: OrchestratorEvent) => void;
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
  evidence: Evidence[];
  verifications: VerificationResult[];
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
    input.onEvent?.(events[0]);
    const pushEvent = (next: OrchestratorEvent): void => {
      events.push(next);
      input.onEvent?.(next);
    };
    const outputs: OrchestratorResult['outputs'] = [];
    const warnings: string[] = [];
    const errors: string[] = [];
    const evidence: Evidence[] = [];
    const verifications: VerificationResult[] = [];
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
      pushEvent(event('planning_completed', {
        providerId: planned.providerId,
        steps: planned.plan.steps.length,
        latencyMs: planned.latencyMs,
        attempts: planned.attempts,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      pushEvent(event('planning_failed', { error: message }));
      return {
        status: 'failed',
        events: [...events, event('run_finished', { status: 'failed' })],
        outputs,
        warnings,
        errors,
        usage: emptyUsage,
        costUsd: 0,
        evidence,
        verifications,
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
        evidence,
        verifications,
      };
    }

    let usage = planned.usage;
    let hasExecutableStep = false;
    let hasVerifiedEvidence = false;
    const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 3, 3));

    for (const step of plan.steps) {
      if (input.signal?.cancelled) {
        warnings.push('RUN_CANCELLED_BY_USER');
        return this.finish('cancelled', plan, planned, events, outputs, warnings, errors, usage, input.model, evidence, verifications);
      }

      pushEvent(event('step_started', { title: step.title, kind: step.kind }, step.id, step.toolId));
      if (!step.toolId) {
        pushEvent(event('step_completed', { verified: false, reason: 'no_tool' }, step.id));
        continue;
      }

      hasExecutableStep = true;
      const tool = getTool(step.toolId);
      if (!tool) {
        errors.push(`UNKNOWN_TOOL:${step.toolId}`);
        pushEvent(event('tool_completed', { ok: false, simulated: false, error: 'UNKNOWN_TOOL' }, step.id, step.toolId));
        return this.finish('failed', plan, planned, events, outputs, warnings, errors, usage, input.model, evidence, verifications);
      }

      if (tool.dangerous) {
        pushEvent(event('permission_requested', { dangerous: true }, step.id, tool.id));
        const allowed = await input.requestPermission?.({ tool, step }) ?? false;
        if (!allowed) {
          const message = `PERMISSION_DENIED:${tool.id}`;
          errors.push(message);
          return this.finish('blocked', plan, planned, events, outputs, warnings, errors, usage, input.model, evidence, verifications);
        }
      }

      let toolArgs = step.toolArgs ?? {};
      let verified = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const result = await runTool(step.toolId, toolArgs);
        const evidenceItem: Evidence = {
          id: `${plan.id}:${step.id}:${attempt}`,
          runId: plan.id,
          taskId: input.taskId ?? plan.id,
          stepId: step.id,
          kind: 'toolResult',
          input: toolArgs,
          output: { ok: result.ok, value: result.output, error: result.error },
          durationMs: result.durationMs,
          simulated: Boolean(result.simulated),
          timestamp: new Date().toISOString(),
        };
        evidence.push(evidenceItem);
        outputs.push({
          stepId: step.id,
          toolId: step.toolId,
          ok: result.ok,
          simulated: Boolean(result.simulated),
          output: result.output,
          error: result.error,
          durationMs: result.durationMs,
        });
        pushEvent(event('tool_completed', {
          ok: result.ok,
          simulated: Boolean(result.simulated),
          durationMs: result.durationMs,
          error: result.error,
          attempt,
        }, step.id, step.toolId));

        const verification = input.verifyStep
          ? await input.verifyStep({ step, output: result.output, evidence: [evidenceItem] })
          : verifyEvidence({ task: step, actualResult: result.output, evidence: [evidenceItem] });
        verifications.push(verification);
        pushEvent(event('step_completed', {
          verified: verification.status === 'VERIFIED',
          verification: verification.status,
          attempt,
        }, step.id, step.toolId));

        if (verification.status === 'VERIFIED') {
          verified = true;
          hasVerifiedEvidence = true;
          break;
        }

        const failureKind = result.ok
          ? verification.failureKind ?? 'VALIDATION_FAILURE'
          : classifyFailure(result.error, 'TOOL_FAILURE');
        if (attempt >= maxAttempts || !input.selfHeal) {
          errors.push(`${failureKind}:${result.error || verification.summary || step.toolId}`);
          break;
        }
        const decision = await input.selfHeal({
          step,
          failureKind,
          verification,
          evidence: [evidenceItem],
          attempt,
        });
        if (!decision || decision.action === 'block') {
          errors.push(`${failureKind}:${result.error || verification.summary || step.toolId}`);
          return this.finish(decision?.action === 'block' ? 'blocked' : 'failed', plan, planned, events, outputs, warnings, errors, usage, input.model, evidence, verifications);
        }
        if (decision.toolArgs) toolArgs = decision.toolArgs;
        warnings.push(`SELF_HEALED:${step.id}:attempt_${attempt}`);
        pushEvent(event('step_started', { recovery: decision.action, attempt: attempt + 1 }, step.id, step.toolId));
      }

      if (!verified) {
        const lastVerification = verifications[verifications.length - 1];
        return this.finish(lastVerification?.status === 'UNVERIFIED' ? 'unverified' : 'failed', plan, planned, events, outputs, warnings, errors, usage, input.model, evidence, verifications);
      }
    }

    if (!hasExecutableStep || !hasVerifiedEvidence) {
      pushEvent(event('verification_required', { hasExecutableStep, hasVerifiedEvidence }));
      warnings.push('NO_VERIFIED_EVIDENCE');
      return this.finish('unverified', plan, planned, events, outputs, warnings, errors, usage, input.model, evidence, verifications);
    }
    return this.finish(warnings.length ? 'completed_with_warnings' : 'completed', plan, planned, events, outputs, warnings, errors, usage, input.model, evidence, verifications);
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
    evidence: Evidence[],
    verifications: VerificationResult[],
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
      evidence,
      verifications,
    };
    return result;
  }
}

export const agentOrchestrator = new AgentOrchestrator();
