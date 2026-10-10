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
 * Model names that are NOT an explicit user choice but a request for the router
 * to pick the best model by task type. The server must pass these through
 * untouched (instead of normalising them to a concrete default) so the Phase E
 * router can actually make the decision inside the Maestro loop.
 */
const ROUTING_SENTINELS = new Set(['', 'auto', 'default', 'test']);

/** True when `model` means "let the router decide by task type". */
export function isRoutingSentinel(model) {
  return ROUTING_SENTINELS.has(String(model ?? '').trim().toLowerCase());
}

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
  long_context: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gpt-5', 'claude-sonnet-4-6', 'gpt-5-mini', 'claude-haiku-4-5'],
  fast: ['gpt-5-mini', 'gemini-3.5-flash-lite', 'claude-haiku-4-5', 'gemini-3-flash-preview', 'gpt-5', 'claude-sonnet-4-6'],
  general: ['gpt-5-mini', 'claude-haiku-4-5', 'gemini-3.5-flash-lite', 'gpt-5', 'claude-sonnet-4-6', 'gemini-3.1-pro-preview'],
});

// Capability + cost/latency/quality hints used for capability-aware selection and
// objective-driven ranking. `vision`/`tools`/`json` are hard capability flags
// (a model that lacks one is filtered out when the request requires it); `quality`
// is a heuristic 0..1 score used only when the caller optimizes for quality. Cost
// and context come straight from the catalog so they can never drift.
const MODEL_META = Object.freeze({
  'gpt-5-mini': { vision: true, tools: true, json: true, quality: 0.78, latencyMs: 120 },
  'gpt-5': { vision: true, tools: true, json: true, quality: 0.95, latencyMs: 220 },
  'gemini-3.5-flash-lite': { vision: true, tools: true, json: true, quality: 0.72, latencyMs: 90 },
  'gemini-3-flash-preview': { vision: true, tools: true, json: true, quality: 0.82, latencyMs: 100 },
  'gemini-3.1-pro-preview': { vision: true, tools: true, json: true, quality: 0.92, latencyMs: 200 },
  'claude-haiku-4-5': { vision: true, tools: true, json: true, quality: 0.75, latencyMs: 140 },
  'claude-sonnet-4-6': { vision: true, tools: true, json: true, quality: 0.93, latencyMs: 260 },
});

/** The optimization objectives `route()` understands. `balanced` = the default priority policy. */
export const ROUTE_OBJECTIVES = Object.freeze(['balanced', 'quality', 'cost', 'latency']);

// How strongly real, observed outcomes (the Experience Engine prior) may re-rank
// the static policy. 0 = ignore experience (pure static policy); 1 = experience
// fully overrides the static order. The default keeps the static policy as the
// prior and lets evidence only *nudge* it, scaled by per-model confidence, so a
// model with no (or little) history can never be demoted on noise.
export const EXPERIENCE_WEIGHT = Number(process.env.AGENT_EXPERIENCE_WEIGHT ?? 0.6);

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

/** Provider of a model id, never throwing (used on the failure path). */
function safeProvider(model) {
  try {
    return modelProvider(model);
  } catch {
    return 'unknown';
  }
}

// Statuses a DIFFERENT model/provider could plausibly survive. A 400/401/403/422
// is a request/auth problem that another model will not fix, so the fallback
// stops early instead of burning the whole chain on a hopeless call.
const RECOVERABLE_STATUS = new Set([404, 408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** Normalise an arbitrary error into the structured diagnostic used in attempts. */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const status = Number(error?.status) || undefined;
  const code = typeof error?.code === 'string' ? error.code : undefined;
  const hint = typeof error?.hint === 'string' ? error.hint : undefined;
  const retryable = status ? RECOVERABLE_STATUS.has(status) : undefined;
  return { message, status, code, hint, retryable };
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
    tools: meta.tools !== false,
    json: meta.json !== false,
    quality: typeof meta.quality === 'number' ? meta.quality : 0.7,
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
  constructor({ taskTypes = TASK_TYPE_MODELS, health = null, experience = null } = {}) {
    this.taskTypes = taskTypes;
    // The health map is the single mutable piece of state. It is injectable so a
    // caller can share one circuit-breaker across runs, while the default is a
    // private map that `fork()` can hand to an isolated per-run router.
    this.health = health instanceof Map ? health : new Map();
    // The Experience Engine prior: `{ [taskType]: { [modelId]: { successRate,
    // confidence, attempts } } }`. Read-only, tenant-scoped and injectable; when
    // absent (the default) routing is byte-for-byte the static policy.
    this.experience = experience && typeof experience === 'object' ? experience : null;
    this.routers = new Map();
    for (const [taskType, chain] of Object.entries(taskTypes)) {
      const descriptors = chain.map((id, index) => this.descriptorFor(id, chain.length - index));
      this.routers.set(taskType, new ModelRouter(descriptors));
    }
    if (!this.routers.has('general')) {
      const descriptors = Object.keys(SUPPORTED_MODELS).map((id) => this.descriptorFor(id, 0));
      this.routers.set('general', new ModelRouter(descriptors));
    }
  }

  descriptorFor(id, priority) {
    const descriptor = descriptorFor(id, priority);
    if (this.health.has(id)) descriptor.healthy = this.health.get(id) !== false;
    return descriptor;
  }

  routerFor(taskType) {
    return this.routers.get(taskType) ?? this.routers.get('general');
  }

  /**
   * Push the (possibly shared) health map into the internal per-task routers
   * before a decision is made. This is what makes `fork({ shareHealth: true })`
   * actually share a circuit breaker: the map is the single source of truth and
   * every router re-reads it, so a health change made on one fork is visible to
   * every other router that shares the same map. Cheap (a handful of models).
   */
  syncHealth() {
    for (const [id, healthy] of this.health) {
      for (const router of this.routers.values()) router.updateHealth(id, healthy);
    }
  }

  /**
   * Return an independent router with the SAME routing policy but a FRESH health
   * state. Each agent run gets its own fork so one run's provider failures can
   * never poison an unrelated run or tenant. Pass `shareHealth: true` to opt
   * back into a cross-run circuit breaker.
   */
  fork({ shareHealth = false } = {}) {
    return new MaestroModelRouter({ taskTypes: this.taskTypes, health: shareHealth ? this.health : new Map(), experience: this.experience });
  }

  /**
   * Install (or clear) the Experience Engine prior for this router. The prior is
   * read-only and tenant-scoped; it only ever *nudges* the static policy, scaled
   * by per-model confidence, so it can never re-rank on thin evidence.
   */
  setExperience(prior) {
    this.experience = prior && typeof prior === 'object' ? prior : null;
    return this;
  }

  /**
   * Re-rank an already-ranked candidate list using the observed-outcome prior.
   *
   * The static rank becomes a 0..1 score (`1` for the top choice). Each candidate
   * is then blended toward its observed success rate in proportion to its
   * confidence:
   *
   *     blended = (1 - w*c) * staticScore + (w*c) * observedSuccessRate
   *
   * With no prior — or with `c = 0` (too little evidence) — `blended` equals the
   * static score, so the order is unchanged. This is what lets a model that keeps
   * succeeding for a task type rise, and one that keeps failing fall, WITHOUT
   * ever discarding the curated cross-provider policy.
   */
  applyExperience(taskType, ranked) {
    const table = this.experience?.[taskType];
    if (!table || !Array.isArray(ranked) || ranked.length < 2 || !Number.isFinite(EXPERIENCE_WEIGHT) || EXPERIENCE_WEIGHT <= 0) {
      return ranked;
    }
    const n = ranked.length;
    const scored = ranked.map((item, index) => {
      const staticScore = (n - index) / n; // 1 for the top choice .. 1/n for the last
      const stat = table[item.id];
      const confidence = stat ? Math.max(0, Math.min(1, Number(stat.confidence) || 0)) : 0;
      const rate = stat && Number.isFinite(Number(stat.successRate)) ? Number(stat.successRate) : 0.5;
      const w = Math.min(1, Math.max(0, EXPERIENCE_WEIGHT)) * confidence;
      const blended = (1 - w) * staticScore + w * rate;
      return {
        item: { ...item, experience: stat ? { successRate: rate, confidence, attempts: Number(stat.attempts) || 0 } : null },
        blended,
        staticScore,
      };
    });
    scored.sort((a, b) => (b.blended - a.blended) || (b.staticScore - a.staticScore));
    return scored.map((entry) => entry.item);
  }

  /** Mark a model healthy/unhealthy across every task-type router. */
  updateHealth(id, healthy, details = {}) {
    this.health.set(id, healthy !== false);
    for (const router of this.routers.values()) router.updateHealth(id, healthy, details);
  }

  /** Ordered eligible model IDs for a task type (the fallback chain). */
  chain(taskType, criteria = {}) {
    const resolved = TASK_TYPES.includes(taskType) ? taskType : classifyTask({ ...criteria, taskType });
    this.syncHealth();
    const ranked = this.applyExperience(resolved, this.routerFor(resolved).rank({ ...criteria, taskType: resolved }));
    return ranked.map((item) => item.id);
  }

  /**
   * The full capability/cost/latency/quality profile of a model. Callers (and the
   * UI) use this to decide whether a model can serve a request before routing.
   */
  capabilities(id) {
    const descriptor = this.descriptorFor(id, 0);
    return {
      id: descriptor.id,
      provider: descriptor.provider,
      vision: descriptor.vision,
      tools: descriptor.tools,
      json: descriptor.json,
      quality: descriptor.quality,
      contextTokens: descriptor.contextTokens,
      costPer1k: descriptor.costPer1k,
      latencyMs: descriptor.latencyMs,
    };
  }

  /**
   * Full routing decision for a request.
   *
   * Beyond the task-type policy, the caller can steer selection with:
   *   - `requires`  : hard capability requirements, e.g. `{ tools: true, json: true, vision: true }`.
   *                   A model lacking a required capability is filtered out (fail-closed).
   *   - `optimize`  : `'quality' | 'cost' | 'latency' | 'balanced'` (default). Non-balanced
   *                   objectives re-order the chain by that objective (priority breaks ties).
   *   - `contextTokens` / `maxCost` / `maxLatencyMs` / `needsVision`: existing hard filters.
   *
   * The default (no `requires`, no `optimize`) is byte-for-byte the previous
   * task-type policy, so existing callers are unaffected.
   */
  route(criteria = {}) {
    const taskType = TASK_TYPES.includes(criteria.taskType) ? criteria.taskType : classifyTask(criteria);
    const optimize = ROUTE_OBJECTIVES.includes(criteria.optimize) ? criteria.optimize : 'balanced';
    this.syncHealth();
    const ranked = this.applyExperience(taskType, this.routerFor(taskType).rank({ ...criteria, taskType, optimize }));
    if (!ranked.length) throw new Error('NO_HEALTHY_MODEL_FOR_REQUIREMENTS');
    const chain = ranked.map((item) => item.id);
    const experienceApplied = Boolean(this.experience?.[taskType]);
    return {
      taskType,
      model: chain[0],
      provider: ranked[0].provider,
      chain,
      optimize,
      requires: criteria.requires ?? null,
      capabilities: this.capabilities(chain[0]),
      experienceApplied,
      experience: ranked[0].experience ?? null,
      reason: `task_type=${taskType}${optimize !== 'balanced' ? ` optimize=${optimize}` : ''}${experienceApplied ? ' experience=on' : ''}`,
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
        attempts.push({ model, provider: safeProvider(model), ok: true });
        return { ok: true, model, provider: safeProvider(model), result, attempts };
      } catch (error) {
        lastError = error;
        this.updateHealth(model, false);
        // Prefer the llm's OWN per-model/per-provider attempts when it performed
        // the failover internally (the providers router attaches `error.attempts`),
        // so the terminal failure carries the REAL reason for every model that was
        // tried — not just the single chain entry. Otherwise fall back to a
        // structured diagnostic for this chain entry.
        const nested = Array.isArray(error?.attempts) ? error.attempts : null;
        if (nested && nested.length) {
          for (const entry of nested) {
            attempts.push({
              model: entry.model ?? model,
              provider: entry.provider ?? safeProvider(model),
              ok: false,
              error: entry.error,
              status: entry.status,
              code: entry.code,
              retryable: entry.retryable,
              hint: entry.hint,
            });
          }
        } else {
          const info = describeError(error);
          attempts.push({
            model,
            provider: safeProvider(model),
            ok: false,
            error: info.message,
            status: info.status,
            code: info.code,
            retryable: info.retryable,
            hint: info.hint,
          });
        }
      }
    }
    const error = new Error(`MAESTRO_ALL_MODELS_FAILED:${attempts.map((attempt) => `${attempt.model}:${attempt.error}`).join('|')}`);
    error.attempts = attempts;
    error.cause = lastError;
    error.code = 'MAESTRO_ALL_MODELS_FAILED';
    error.failureKind = 'MODEL_ROUTING_FAILURE';
    error.summary = `Every model in the fallback chain failed (${attempts.length} attempt${attempts.length === 1 ? '' : 's'}): ` +
      attempts.map((attempt) => `${attempt.model}[${attempt.provider}]${attempt.status ? ` ${attempt.status}` : ''}${attempt.code ? ` ${attempt.code}` : ''}`).join(', ');
    throw error;
  }

  /**
   * Resolve a fallback chain into the ACTUAL provider/model pairs each candidate
   * will be dispatched to, given the providers the underlying llm has configured.
   * Used purely for observability: it lets the runtime report the real dispatch
   * (e.g. "gpt-5 requested, gemini-3.5-flash-lite served") instead of implying the
   * requested family was used. Never throws; returns null when the llm cannot
   * describe itself.
   */
  resolveDispatch(chain, llm) {
    if (!llm || typeof llm.plan !== 'function') return null;
    try {
      return chain.map((model) => {
        const family = safeProvider(model);
        let plan = null;
        try { plan = llm.plan(model); } catch { plan = null; }
        const first = Array.isArray(plan) && plan.length ? plan[0] : null;
        return {
          model,
          family,
          dispatchProvider: first?.provider ?? family,
          dispatchModel: first?.model ?? model,
          substituted: first ? first.substituted === true : false,
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * Collapse a fallback chain to AT MOST ONE candidate per provider the
   * underlying llm would actually dispatch to.
   *
   * The Maestro chain is a routing POLICY (the best model per task type, and it
   * deliberately spans every family). When the llm can describe its dispatch
   * (exposes `plan()`), re-trying every chain entry would re-hit the SAME
   * providers once per entry — e.g. with only a Gemini key configured, all six
   * chain candidates remap to Gemini, so the "fallback" would call Gemini six
   * times. Collapsing keeps the policy ORDER (the first, best candidate per
   * provider wins) while letting the llm perform the within-provider failover
   * itself. Plain/fake llms (no `plan`) keep the full chain unchanged.
   */
  collapseByDispatch(chain, llm) {
    if (!Array.isArray(chain) || chain.length < 2) return chain;
    if (!llm || typeof llm.plan !== 'function') return chain;
    const seen = new Set();
    const collapsed = [];
    for (const model of chain) {
      let provider = safeProvider(model);
      try {
        const plan = llm.plan(model);
        if (Array.isArray(plan) && plan.length && plan[0].provider) provider = plan[0].provider;
      } catch { /* keep the family provider */ }
      if (seen.has(provider)) continue;
      seen.add(provider);
      collapsed.push(model);
    }
    return collapsed.length ? collapsed : chain;
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
        // Keep the chain a routing POLICY: one entry per provider the llm will
        // actually dispatch to, so a provider is not re-tried once per candidate.
        chain = router.collapseByDispatch(chain, llm);
        const outcome = await router.runWithFallback(chain, (candidate) => llm.complete({ ...input, model: candidate }));
        return {
          ...outcome.result,
          model: outcome.result?.model ?? outcome.model,
          requestedModel: input.model ?? outcome.model,
          routedModel: outcome.model,
          routedProvider: outcome.provider,
          routeTaskType: decision.taskType,
          routeChain: chain,
          routeDispatch: router.resolveDispatch(chain, llm),
          routeAttempts: outcome.attempts,
        };
      },
    };
    // Observability: expose the resolved provider/model dispatch for a chain so
    // callers can log exactly where a request will go (and whether it will be
    // transparently substituted) BEFORE the call is made.
    wrapper.resolve = (chain) => router.resolveDispatch(Array.isArray(chain) ? chain : [], llm);
    if (typeof llm.status === 'function') wrapper.status = (...args) => llm.status(...args);
    if (typeof llm.stream === 'function') wrapper.stream = (...args) => llm.stream(...args);
    return wrapper;
  }
}

export const maestroModelRouter = new MaestroModelRouter();
