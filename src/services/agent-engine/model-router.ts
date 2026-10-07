import { MODELS, getModel } from '../../data/models';
import type { ChatCompletionRequest, ChatCompletionResult, ProviderId } from '../../types/model';
import type { LLMProvider } from '../ai/provider';

/* -------------------------------------------------------------------------- */
/*  AI Model Router for the Maestro (AgentOrchestrator)                       */
/* -------------------------------------------------------------------------- */
/*
 * Picks a model (Claude / GPT / Gemini) from the *type* of the task and returns
 * a cross-provider fallback chain used when a model call fails. It reuses the
 * existing app model catalog (`src/data/models`) and the existing `LLMProvider`
 * contract, and is delivered to the existing `AgentOrchestrator`/`LLMPlanner`
 * as an ordered provider list or a drop-in provider — the orchestrator itself
 * is never rebuilt or modified.
 */

/** The task taxonomy the router understands. */
export type MaestroTaskType = 'code' | 'reasoning' | 'vision' | 'long_context' | 'fast' | 'general';

export const TASK_TYPES: MaestroTaskType[] = ['code', 'reasoning', 'vision', 'long_context', 'fast', 'general'];

/**
 * Task type -> ordered model preference (best first). Every chain spans all
 * three families (Anthropic / OpenAI / Google) so a failure in one family falls
 * through to a different provider. IDs must exist in `MODELS`.
 */
export const TASK_TYPE_MODELS: Record<MaestroTaskType, string[]> = {
  code: ['claude-sonnet-4-6', 'gpt-5', 'gemini-3.1-pro-preview', 'claude-haiku-4-5', 'gpt-5-mini', 'gemini-3-flash-preview'],
  reasoning: ['gpt-5', 'claude-sonnet-4-6', 'gemini-3.1-pro-preview', 'gpt-5-mini', 'claude-haiku-4-5', 'gemini-3-flash-preview'],
  vision: ['gemini-3.1-pro-preview', 'gpt-5', 'claude-sonnet-4-6', 'gemini-3-flash-preview', 'gpt-5-mini', 'claude-haiku-4-5'],
  long_context: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gpt-5', 'claude-sonnet-4-6', 'gpt-5-mini', 'claude-haiku-4-5'],
  fast: ['gpt-5-mini', 'claude-haiku-4-5', 'gemini-3-flash-preview', 'gpt-5', 'claude-sonnet-4-6'],
  general: ['gpt-5-mini', 'claude-haiku-4-5', 'gemini-3-flash-preview', 'gpt-5', 'claude-sonnet-4-6', 'gemini-3.1-pro-preview'],
};

const TASK_HINTS: { taskType: MaestroTaskType; pattern: RegExp }[] = [
  { taskType: 'vision', pattern: /(image|photo|picture|screenshot|diagram|chart|vision|multimodal|صورة|صور|لقطة|رسم|مخطط)/i },
  { taskType: 'code', pattern: /(code|bug|refactor|function|class|compile|debug|test|script|typescript|javascript|python|كود|برمج|خطأ|اختبار|دالة|دوال|إصلاح)/i },
  { taskType: 'long_context', pattern: /(summar|document|docs|pdf|long|entire|whole|codebase|book|report|لخّص|لخص|مستند|ملف|طويل|كامل|تقرير)/i },
  { taskType: 'reasoning', pattern: /(reason|prove|proof|math|logic|analy|plan|strategy|design|استدلال|منطق|تحليل|خطة|تصميم|رياض|برهن|فكر)/i },
  { taskType: 'fast', pattern: /(quick|fast|simple|short|trivial|سريع|بسيط|مختصر)/i },
];

export interface MaestroRoutingInput {
  goal?: string;
  taskType?: MaestroTaskType;
  needsVision?: boolean;
  contextTokens?: number;
  maxCostPerMTokens?: number;
}

export interface RouteDecision {
  taskType: MaestroTaskType;
  model: string;
  provider: ProviderId;
  chain: string[];
}

export interface RouteAttempt {
  model: string;
  provider: ProviderId;
  ok: boolean;
  error?: string;
}

export interface FallbackOutcome<T> {
  ok: true;
  model: string;
  provider: ProviderId;
  result: T;
  attempts: RouteAttempt[];
}

/** Classify a goal/request into a {@link MaestroTaskType}. Explicit hints win. */
export function classifyTask(input: MaestroRoutingInput | string = {}): MaestroTaskType {
  const source: MaestroRoutingInput = typeof input === 'string' ? { goal: input } : input;
  const explicit = String(source.taskType ?? '').trim().toLowerCase() as MaestroTaskType;
  if (TASK_TYPES.includes(explicit)) return explicit;
  if (source.needsVision === true) return 'vision';
  const contextTokens = Number(source.contextTokens);
  if (Number.isFinite(contextTokens) && contextTokens >= 200_000) return 'long_context';
  const text = String(source.goal ?? '');
  for (const hint of TASK_HINTS) {
    if (hint.pattern.test(text)) return hint.taskType;
  }
  return 'general';
}

function providerOf(model: string): ProviderId {
  return getModel(model)?.provider ?? 'openai';
}

function blendedCost(model: string): number {
  const spec = getModel(model);
  if (!spec) return Infinity;
  return (spec.inputPricePerMTokens + spec.outputPricePerMTokens) / 2;
}

/**
 * Task-type aware, health-aware, fallback-capable model router for the Maestro.
 */
export class MaestroModelRouter {
  private readonly health = new Map<string, boolean>();

  /** Ordered eligible model IDs for a task type (the fallback chain). */
  chain(taskType: MaestroTaskType, criteria: MaestroRoutingInput = {}): string[] {
    const resolved = TASK_TYPES.includes(taskType) ? taskType : classifyTask({ ...criteria, taskType });
    const preference = TASK_TYPE_MODELS[resolved] ?? TASK_TYPE_MODELS.general;
    const needsVision = criteria.needsVision === true;
    const contextTokens = Number(criteria.contextTokens ?? 0);
    const maxCost = Number(criteria.maxCostPerMTokens ?? Infinity);
    return preference.filter((id) => {
      if (this.health.get(id) === false) return false;
      const spec = getModel(id);
      if (!spec) return false;
      if (needsVision && !spec.capabilities.includes('vision')) return false;
      if (spec.contextWindow < contextTokens) return false;
      if (blendedCost(id) > maxCost) return false;
      return true;
    });
  }

  /** Full routing decision for a request. */
  route(criteria: MaestroRoutingInput = {}): RouteDecision {
    const taskType = TASK_TYPES.includes(criteria.taskType as MaestroTaskType)
      ? (criteria.taskType as MaestroTaskType)
      : classifyTask(criteria);
    const chain = this.chain(taskType, criteria);
    if (chain.length === 0) throw new Error('NO_HEALTHY_MODEL_FOR_REQUIREMENTS');
    return { taskType, model: chain[0] as string, provider: providerOf(chain[0] as string), chain };
  }

  /** Mark a model healthy/unhealthy. */
  updateHealth(model: string, healthy: boolean): void {
    this.health.set(model, healthy);
  }

  /** Ordered, de-duplicated providers for a chain (only configured providers). */
  orderProviders(chain: string[], providers: LLMProvider[]): LLMProvider[] {
    const byId = new Map<ProviderId, LLMProvider>(providers.map((provider) => [provider.id, provider]));
    const ordered: LLMProvider[] = [];
    const seen = new Set<ProviderId>();
    for (const model of chain) {
      const providerId = providerOf(model);
      const provider = byId.get(providerId);
      if (provider && !seen.has(providerId)) {
        ordered.push(provider);
        seen.add(providerId);
      }
    }
    return ordered;
  }

  /**
   * Ready-to-use input for `AgentOrchestrator.run`: the chosen model plus the
   * providers ordered by the fallback chain. `LLMPlanner` already retries the
   * provider list in order, so this is the whole Maestro wiring.
   */
  routeForOrchestrator(input: MaestroRoutingInput & { providers: LLMProvider[] }): RouteDecision & { providers: LLMProvider[] } {
    const decision = this.route(input);
    return { ...decision, providers: this.orderProviders(decision.chain, input.providers) };
  }

  /**
   * Run `run(model)` over a chain until one succeeds, marking health as it goes.
   * Throws `MAESTRO_ALL_MODELS_FAILED` (with `.attempts`) when every model fails.
   */
  async runWithFallback<T>(chain: string[], run: (model: string) => Promise<T>): Promise<FallbackOutcome<T>> {
    const attempts: RouteAttempt[] = [];
    let lastError: unknown;
    for (const model of chain) {
      try {
        const result = await run(model);
        this.updateHealth(model, true);
        attempts.push({ model, provider: providerOf(model), ok: true });
        return { ok: true, model, provider: providerOf(model), result, attempts };
      } catch (error) {
        lastError = error;
        this.updateHealth(model, false);
        attempts.push({ model, provider: providerOf(model), ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const error = new Error(`MAESTRO_ALL_MODELS_FAILED:${attempts.map((attempt) => `${attempt.model}:${attempt.error}`).join('|')}`) as Error & { attempts?: RouteAttempt[]; cause?: unknown };
    error.attempts = attempts;
    error.cause = lastError;
    throw error;
  }

  /**
   * Wrap the configured providers so the Maestro routes by task type and falls
   * back across providers on failure. The result satisfies `LLMProvider`, so it
   * is a drop-in replacement inside `AgentOrchestrator`.
   */
  createRoutedProvider(options: MaestroRoutingInput & { providers: LLMProvider[] }): LLMProvider {
    const { providers, taskType, goal, ...criteria } = options;
    if (!providers || providers.length === 0) throw new Error('ROUTED_PROVIDER_REQUIRES_PROVIDERS');
    const router = this;
    const byId = new Map<ProviderId, LLMProvider>(providers.map((provider) => [provider.id, provider]));
    const primary = providers[0] as LLMProvider;
    const resolveTaskType = (): MaestroTaskType => {
      if (TASK_TYPES.includes(taskType as MaestroTaskType)) return taskType as MaestroTaskType;
      return classifyTask(goal === undefined ? criteria : { ...criteria, goal });
    };

    return {
      id: primary.id,
      live: primary.live,
      async complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
        const chain = router.chain(resolveTaskType(), criteria);
        const outcome = await router.runWithFallback(chain, async (model) => {
          const provider = byId.get(providerOf(model));
          if (!provider) throw new Error(`NO_PROVIDER_FOR_MODEL:${model}`);
          return provider.complete({ ...req, model });
        });
        return { ...outcome.result, model: outcome.result.model ?? outcome.model };
      },
      async *stream(req: ChatCompletionRequest) {
        const chain = router.chain(resolveTaskType(), criteria);
        let lastError: unknown;
        for (const model of chain) {
          const provider = byId.get(providerOf(model));
          if (!provider) {
            lastError = new Error(`NO_PROVIDER_FOR_MODEL:${model}`);
            continue;
          }
          try {
            yield* provider.stream({ ...req, model });
            router.updateHealth(model, true);
            return;
          } catch (error) {
            router.updateHealth(model, false);
            lastError = error;
          }
        }
        throw lastError ?? new Error('MAESTRO_ALL_MODELS_FAILED');
      },
    };
  }
}

export const maestroModelRouter = new MaestroModelRouter();

/** All model IDs referenced by the router must exist in the catalog. */
export function validateTaskTypeModels(): string[] {
  const missing: string[] = [];
  const known = new Set(MODELS.map((model) => model.id));
  for (const chain of Object.values(TASK_TYPE_MODELS)) {
    for (const id of chain) if (!known.has(id)) missing.push(id);
  }
  return missing;
}
