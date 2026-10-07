export class ModelRouter {
  constructor(providers = []) { this.providers = providers.map((provider) => ({ ...provider, healthy: provider.healthy !== false })); }
  updateHealth(id, healthy, details = {}) { const provider = this.providers.find((item) => item.id === id); if (provider) Object.assign(provider, { healthy, ...details, checkedAt: new Date().toISOString() }); }
  eligible({ taskType = 'general', needsVision = false, contextTokens = 0, maxLatencyMs = Infinity, maxCost = Infinity } = {}) {
    return this.providers.filter((provider) => provider.healthy && (!needsVision || provider.vision) && (!provider.taskTypes || provider.taskTypes.includes(taskType)) && (provider.contextTokens ?? 0) >= contextTokens && (provider.latencyMs ?? Infinity) <= maxLatencyMs && (provider.costPer1k ?? Infinity) <= maxCost);
  }
  // Ordered eligible providers: explicit `priority` first (higher wins, optional and
  // therefore backward compatible), then the original cost/latency heuristic.
  rank(criteria = {}) {
    const candidates = this.eligible(criteria);
    candidates.sort((a, b) => ((b.priority ?? 0) - (a.priority ?? 0)) || (((a.latencyMs ?? 0) + (a.costPer1k ?? 0) * 100) - ((b.latencyMs ?? 0) + (b.costPer1k ?? 0) * 100)));
    return candidates;
  }
  choose(criteria = {}) {
    const candidates = this.rank(criteria);
    if (!candidates[0]) throw new Error('NO_HEALTHY_MODEL_FOR_REQUIREMENTS');
    return candidates[0];
  }
  fallbackOrder(criteria) { const first = this.choose(criteria); return [first, ...this.providers.filter((item) => item.id !== first.id && item.healthy)]; }
}
