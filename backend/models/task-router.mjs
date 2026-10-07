// AI Model Router for the Maestro orchestrator.
//
// Picks a model (Claude / GPT / Gemini) from the *type* of the task and returns a
// cross-provider fallback chain used when a model call fails. It reuses the
// existing building blocks instead of rebuilding anything:
//
//   * `ModelRouter`            -> health tracking, eligibility filtering, ranking
//   * `backend/models/catalog` -> the single source of truth for model IDs/providers
//
// The router is delivered to the existing Maestro (`createAgentRunHandler`) as a
// drop-in `llm` decorator (`createRoutedLLM`), so the Agent/Core is never edited.
import { ModelRouter } from './router.mjs';
import { SUPPORTED_MODELS, normalizeModelId, modelProvider } from './catalog.mjs';

/** The task taxonomy the router understands. */
export const TASK_TYPES = Object.freeze(['code', 'reasoning', 'vision', 'long_context', 'fast', 'general']);

/**
 * Task type -> ordered model preference (best first).
 *
 * Every chain deliberately spans all three families (Anthropic / OpenAI / Google)
 * so that a failure in one family falls through to a different provider instead
 * of retrying the same one. Order encodes the routing policy; the actual model
 * IDs are validated against the catalog at construction time.
 */
export const TASK_TYPE_MODELS = Object.freeze({
  code: ['claude-sonnet-4-6', 'gpt-5', 'gemini-3.1-pro-preview', 'claude-haiku-4-5', 'gpt-5-mini', 'gemini-3-flash-preview'],
  reasoning: ['gpt-5', 'claude-sonnet-4-6', 'gemini-3.1-pro-preview', 'gpt-5-mini', 'claude-haiku-4-5', 'gemini-3-flash-preview'],
  vision: ['gemini-3.1-pro-preview', 'gpt-5', 'claude-sonnet-4-6', 'gemini-3-flash-preview', 'gpt-5-mini', 'claude-haiku-4-5'],
  long_context: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gpt-5', 'claude-sonnet-4-6', 'gpt-5-mini', 'claude-haiku-4-5'],
  fast: ['gpt-5-mini', 'gemini-2.5-flash-lite', 'claude-haiku-4-5', 'gemini-3-flash-preview', 'gpt-5', 'claude-sonnet-4-6'],
  general: ['gpt-5-mini', 'claude-haiku-4-5', 'gemini-2.5-flash-lite', 'gpt-5', 'claude-sonnet-4-6', 'gemini-3.1-pro-preview'],
});

// Non-catalog hints (latency, vision) used only for tie-breaking inside a tier.
// Cost and context come straight from the catalog so they can never drift.
const MODEL_META = Object.freeze({
  'gpt-5-mini': { vision: true, latencyMs: 120 },
  'gpt-5': { vision: true, latencyMs: 220 },
  'gemini-2.5-flash-lite': { vision: true, latencyMs: 90 },
  'gemini-3-flash-preview': { vision: true, latencyMs: 100 },
  'gemini-3.1-pro-preview': { vision: true, latencyMs: 200 },
  'claude-haiku-4-5': { vision: true, latencyMs: 140 },
  'claude-sonnet-4-6': { vision: true, latencyMs: 260 },
});

// Deterministic, dependency-free goal classification. Ordered most-specific first.
const TASK_HINTS = Object.freeze({
  vision: /(image|photo|picture|screenshot|diagram|chart|vision|multimodal|صورة|صور|لقطة|رسم|مخطط)/i,
  code: /(code|bug|refactor|function|class|compile|debug|test|script|typescript|javascript|python|كود|برمج|خطأ|اختبار|دالة|دوال|إصلاح)/i,
  long_context: /(summar|document|docs|pdf|long|entire|whole|codebase|book|report|لخّص|لخص|مستند|ملف|طويل|كامل|تقرير)/i,
  reasoning: /(reason|prove|proof|math|logic|analy|plan|strategy|design|استدلال|منطق|تحليل|خطة|تصميم|رياض|برهن|فكر)/i,
  fast: /(quick|fast|simple|short|trivial|سريع|بسيط|مختصر)/i,
});

/**
 * Classify a goal/request into one of {@link TASK_TYPES}.
 * Accepts a plain string goal or a criteria object. Explicit `taskType`,
 * `needsVision` and `contextTokens` hints always win over keyword heuristics.
 */
export function classifyTask(input = {}) {
  const source = typeof input === 'string' ? { goal: input } : (input ?? {});
  const explicit = String(source.taskType || '').trim().toLowerCase();
  if (TASK_TYPES.includes(explicit)) return explicit;
  if (source.needsVision === true) return 'vision';
  const contextTokens = Number(source.contextTokens);
  if (Number.isFinite(contextTokens) && contextTokens >= 200_000) return 'long_context';
  const text = String(source.goal ?? source.text ?? source.task ?? source.prompt ?? '');
  for (const taskType of ['vision', 'code', 'long_context', 'reasoning', 'fast']) {
    if (TASK_HINTS[taskType].test(text)) return taskType;
  }
  return 'general';
}

function descriptorFor(id, priority) {
  const spec = SUPPORTED_MODELS[id];
  if (!spec) throw new Error(`UNKNOWN_ROUTER_MODEL:${id}`);
  const meta = MODEL_META[id] ?? {};
  return {
    id,
    provider: spec.provider,
    priority,
    healthy: true,
    vision: meta.vision !== false,
    contextTokens: spec.context,
    costPer1k: meta.costPer1k ?? (spec.input + spec.output) / 2,
    latencyMs: meta.latencyMs ?? 150,
  };
}

/**
 * Task-type aware, health-aware, fallback-capable model router.
 *
 * One internal {@link ModelRouter} is built per task type, with the preference
 * order encoded as `priority`, so the existing router does the eligibility
 * filtering and ranking and this class only adds the routing policy + fallback.
 */
export class MaestroModelRouter {
  constructor({ taskTypes = TASK_TYPE_MODELS } = {}) {
    this.routers = new Map();
    for (const [taskType, chain] of Object.entries(taskTypes)) {
      const descriptors = chain.map((id, index) => descriptorFor(id, chain.length - index));
      this.routers.set(taskType, new ModelRouter(descriptors));
    }
    if (!this.routers.has('general')) {
      const descriptors = Object.keys(SUPPORTED_MODELS).map((id) => descriptorFor(id, 0));
      this.routers.set('general', new ModelRouter(descriptors));
    }
  }

  routerFor(taskType) {
    return this.routers.get(taskType) ?? this.routers.get('general');
  }

  /** Mark a model healthy/unhealthy across every task-type router. */
  updateHealth(id, healthy, details = {}) {
    for (const router of this.routers.values()) router.updateHealth(id, healthy, details);
  }

  /** Ordered eligible model IDs for a task type (the fallback chain). */
  chain(taskType, criteria = {}) {
    const resolved = TASK_TYPES.includes(taskType) ? taskType : classifyTask({ ...criteria, taskType });
    return this.routerFor(resolved).rank({ ...criteria, taskType: resolved }).map((item) => item.id);
  }

  /** Full routing decision for a request. */
  route(criteria = {}) {
    const taskType = TASK_TYPES.includes(criteria.taskType) ? criteria.taskType : classifyTask(criteria);
    const ranked = this.routerFor(taskType).rank({ ...criteria, taskType });
    if (!ranked.length) throw new Error('NO_HEALTHY_MODEL_FOR_REQUIREMENTS');
    const chain = ranked.map((item) => item.id);
    return {
      taskType,
      model: chain[0],
      provider: ranked[0].provider,
      chain,
      reason: `task_type=${taskType}`,
    };
  }

  /**
   * Run `run(model)` over a chain until one succeeds, marking health as it goes.
   * Throws `MAESTRO_ALL_MODELS_FAILED` (with `.attempts`) when every model fails.
   */
  async runWithFallback(chain, run) {
    if (typeof run !== 'function') throw new Error('ROUTER_RUN_REQUIRED');
    const attempts = [];
    let lastError;
    for (const model of chain) {
      try {
        const result = await run(model);
        this.updateHealth(model, true);
        attempts.push({ model, provider: modelProvider(model), ok: true });
        return { ok: true, model, provider: modelProvider(model), result, attempts };
      } catch (error) {
        lastError = error;
        this.updateHealth(model, false);
        attempts.push({ model, provider: modelProvider(model), ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const error = new Error(`MAESTRO_ALL_MODELS_FAILED:${attempts.map((attempt) => `${attempt.model}:${attempt.error}`).join('|')}`);
    error.attempts = attempts;
    error.cause = lastError;
    throw error;
  }

  /**
   * Wrap an existing `llm` (e.g. `createLLMRouter()`) so the Maestro picks the
   * model by task type and falls back across providers on failure. The returned
   * object keeps the exact `{ complete, stream, status }` contract the agent
   * runtime already consumes, so it is a drop-in replacement.
   */
  createRoutedLLM({ llm, taskType, goal, criteria = {}, honorRequestedModel = false } = {}) {
    if (!llm || typeof llm.complete !== 'function') throw new Error('ROUTED_LLM_REQUIRES_COMPLETE');
    const router = this;
    const wrapper = {
      async complete(input = {}) {
        const resolvedTaskType = TASK_TYPES.includes(taskType) ? taskType : classifyTask({ ...criteria, goal: goal ?? input.goal });
        const decision = router.route({ ...criteria, taskType: resolvedTaskType });
        let chain = decision.chain;
        if (honorRequestedModel && input.model) {
          try {
            const requested = normalizeModelId(input.model);
            if (chain[0] !== requested) chain = [requested, ...chain.filter((id) => id !== requested)];
          } catch { /* ignore an invalid requested model and keep the routed chain */ }
        }
        const outcome = await router.runWithFallback(chain, (candidate) => llm.complete({ ...input, model: candidate }));
        return {
          ...outcome.result,
          model: outcome.result?.model ?? outcome.model,
          requestedModel: input.model ?? outcome.model,
          routedModel: outcome.model,
          routedProvider: outcome.provider,
          routeTaskType: decision.taskType,
          routeChain: chain,
          routeAttempts: outcome.attempts,
        };
      },
    };
    if (typeof llm.status === 'function') wrapper.status = (...args) => llm.status(...args);
    if (typeof llm.stream === 'function') wrapper.stream = (...args) => llm.stream(...args);
    return wrapper;
  }
}

export const maestroModelRouter = new MaestroModelRouter();
