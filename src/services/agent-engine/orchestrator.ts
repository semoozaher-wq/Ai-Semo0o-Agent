import type { LLMProvider } from '../ai/provider';
import { getTool } from '../../data/tools';
import { getModel } from '../../data/models';
import type { Plan, PlanStep } from '../../types/task';
import type { ToolDefinition } from '../../types/tool';
import { runTool } from './tools';
import { LLMPlanner, type LLMPlanResult } from './llm-planner';
import {
  maestroModelRouter,
  type MaestroModelRouter,
  type MaestroRoutingInput,
  type MaestroTaskType,
} from './model-router';
import {
  classifyFailure,
  recoveryActionFor,
  verifyEvidence,
  RECOVERY_EVENTS,
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
    | 'routing_decision'
    | 'planning_started'
    | 'planning_completed'
    | 'planning_failed'
    | 'permission_requested'
    | 'step_started'
    | 'tool_completed'
    | 'step_completed'
    | 'self_healing'
    | 'self_healing_failed'
    | 'verification_required'
    | 'run_finished';
  stepId?: string | undefined;
  toolId?: string | undefined;
  details?: Record<string, unknown> | undefined;
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
  /**
   * When true (the default) the Phase E Model Router runs INSIDE this loop:
   * it classifies the goal, picks the best model for the task type and wraps the
   * configured providers so a failed call falls back across providers. Set to
   * false only for tests that need to exercise the raw provider list.
   */
  routing?: boolean;
  /** Injectable router (defaults to the shared singleton) for testing. */
  modelRouter?: MaestroModelRouter;
  /** Optional explicit task type / vision hint for the router. */
  taskType?: MaestroTaskType;
  needsVision?: boolean;
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
    toolId?: string | undefined;
    ok: boolean;
    simulated: boolean;
    output: unknown;
    error?: string | undefined;
    durationMs?: number | undefined;
  }[];
  warnings: string[];
  errors: string[];
  usage: LLMPlanResult['usage'];
  costUsd: number;
  evidence: Evidence[];
  verifications: VerificationResult[];
  /** The model actually used for the run (after Phase E routing). */
  model?: string;
}

const emptyUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function estimateCostUsd(modelId: string, usage: LLMPlanResult['usage']): number {
  const model = getModel(modelId);
  if (!model) return 0;
  return (usage.promptTokens / 1_000_000) * model.inputPricePerMTokens
    + (usage.completionTokens / 1_000_000) * model.outputPricePerMTokens;
}

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
    const firstEvent = event('planning_started');
    const events: OrchestratorEvent[] = [firstEvent];
    input.onEvent?.(firstEvent);
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

    // ---------------------------------------------------------------------
    // Phase E Model Router wired INSIDE the Maestro loop. The goal is
    // classified, the best model for that task type is chosen and the
    // configured providers are wrapped so a failed call falls back across
    // providers (Anthropic / OpenAI / Google) with live health tracking.
    // ---------------------------------------------------------------------
    let model = input.model;
    let providers = input.providers;
    if (input.routing !== false && providers.length > 0) {
      // Health is tracked on a PER-RUN fork of the router so a provider outage
      // in one run can never silently poison an unrelated run or tenant. The
      // routing policy (task-type chains) is shared; only health is isolated.
      const router = (input.modelRouter ?? maestroModelRouter).fork();
      const routingInput: MaestroRoutingInput = { goal: input.goal };
      if (input.taskType) routingInput.taskType = input.taskType;
      if (input.needsVision !== undefined) routingInput.needsVision = input.needsVision;
      const decision = router.route(routingInput);
      const routed = router.createRoutedProvider({ ...routingInput, providers });
      model = decision.model;
      providers = [routed];
      pushEvent(event('routing_decision', {
        taskType: decision.taskType,
        model: decision.model,
        provider: decision.provider,
        chain: decision.chain,
      }));
    }

    let planned: LLMPlanResult;
    try {
      planned = await this.planner.plan(input.goal, {
        model,
        providers,
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
        model,
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
        costUsd: estimateCostUsd(model, planned.usage),
        evidence,
        verifications,
        model,
      };
    }

    let usage = planned.usage;
    let hasExecutableStep = false;
    let hasVerifiedEvidence = false;
    const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 3, 3));

    for (const step of plan.steps) {
      if (input.signal?.cancelled) {
        warnings.push('RUN_CANCELLED_BY_USER');
        return this.finish('cancelled', plan, planned, events, outputs, warnings, errors, usage, model, evidence, verifications);
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
        return this.finish('failed', plan, planned, events, outputs, warnings, errors, usage, model, evidence, verifications);
      }

      if (tool.dangerous) {
        pushEvent(event('permission_requested', { dangerous: true }, step.id, tool.id));
        const allowed = await input.requestPermission?.({ tool, step }) ?? false;
        if (!allowed) {
          const message = `PERMISSION_DENIED:${tool.id}`;
          errors.push(message);
          return this.finish('blocked', plan, planned, events, outputs, warnings, errors, usage, model, evidence, verifications);
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
          // No healer is available (or attempts are exhausted). Record the SAME
          // `self_healing_failed` event the backend emits, carrying the bounded
          // policy decision so the two timelines are identical.
          pushEvent(event(RECOVERY_EVENTS.selfHealingFailed, {
            action: recoveryActionFor({ failureKind, attempt, maxAttempts, canRepair: Boolean(input.selfHeal) }),
            failureKind,
            attempt,
            reason: input.selfHeal ? 'attempts_exhausted' : 'no_healer',
          }, step.id, step.toolId));
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
          pushEvent(event(RECOVERY_EVENTS.selfHealingFailed, { action: 'block', failureKind, attempt }, step.id, step.toolId));
          errors.push(`${failureKind}:${result.error || verification.summary || step.toolId}`);
          return this.finish(decision?.action === 'block' ? 'blocked' : 'failed', plan, planned, events, outputs, warnings, errors, usage, model, evidence, verifications);
        }
        if (decision.toolArgs) toolArgs = decision.toolArgs;
        // The unified recovery event: identical name and payload shape to the
        // backend (`backend/agent/runtime.mjs`), so a timeline renders the same
        // on both sides.
        pushEvent(event(RECOVERY_EVENTS.selfHealing, { action: decision.action, failureKind, attempt }, step.id, step.toolId));
        warnings.push(`SELF_HEALED:${step.id}:attempt_${attempt}`);
        pushEvent(event('step_started', { recovery: decision.action, attempt: attempt + 1 }, step.id, step.toolId));
      }

      if (!verified) {
        const lastVerification = verifications[verifications.length - 1];
        return this.finish(lastVerification?.status === 'UNVERIFIED' ? 'unverified' : 'failed', plan, planned, events, outputs, warnings, errors, usage, model, evidence, verifications);
      }
    }

    if (!hasExecutableStep || !hasVerifiedEvidence) {
      pushEvent(event('verification_required', { hasExecutableStep, hasVerifiedEvidence }));
      warnings.push('NO_VERIFIED_EVIDENCE');
      return this.finish('unverified', plan, planned, events, outputs, warnings, errors, usage, model, evidence, verifications);
    }
    return this.finish(warnings.length ? 'completed_with_warnings' : 'completed', plan, planned, events, outputs, warnings, errors, usage, model, evidence, verifications);
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
      costUsd: estimateCostUsd(model, usage),
      evidence,
      verifications,
      model,
    };
    return result;
  }
}

export const agentOrchestrator = new AgentOrchestrator();
