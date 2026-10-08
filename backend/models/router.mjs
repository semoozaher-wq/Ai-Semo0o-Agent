export class ModelRouter {
  constructor(providers = []) { this.providers = providers.map((provider) => ({ ...provider, healthy: provider.healthy !== false })); }
  updateHealth(id, healthy, details = {}) { const provider = this.providers.find((item) => item.id === id); if (provider) Object.assign(provider, { healthy, ...details, checkedAt: new Date().toISOString() }); }
  eligible({ taskType = 'general', needsVision = false, contextTokens = 0, maxLatencyMs = Infinity, maxCost = Infinity, requires = null } = {}) {
    const need = requires ?? {};
    return this.providers.filter((provider) => provider.healthy
      && (!needsVision || provider.vision)
      && (!need.vision || provider.vision)
      && (!need.tools || provider.tools !== false)
      && (!need.json || provider.json !== false)
      && (!provider.taskTypes || provider.taskTypes.includes(taskType))
      && (provider.contextTokens ?? 0) >= contextTokens
      && (provider.latencyMs ?? Infinity) <= maxLatencyMs
      && (provider.costPer1k ?? Infinity) <= maxCost);
  }
  // Ordered eligible providers: explicit `priority` first (higher wins, optional and
  // therefore backward compatible), then the original cost/latency heuristic.
  // When `optimize` is 'quality' | 'cost' | 'latency' the candidates are re-ordered
  // by that objective instead (priority breaks ties). 'balanced'/unset keeps the
  // original priority-then-cost/latency ordering, so existing callers are unaffected.
  rank(criteria = {}) {
    const candidates = this.eligible(criteria);
    const optimize = criteria.optimize;
    if (optimize === 'quality' || optimize === 'cost' || optimize === 'latency') {
      const metric = optimize === 'quality'
        ? (item) => -(item.quality ?? 0)
        : optimize === 'cost'
          ? (item) => item.costPer1k ?? Infinity
          : (item) => item.latencyMs ?? Infinity;
      candidates.sort((a, b) => (metric(a) - metric(b)) || ((b.priority ?? 0) - (a.priority ?? 0)));
      return candidates;
    }
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
