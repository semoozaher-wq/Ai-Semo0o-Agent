import { randomUUID } from 'node:crypto';

export function createTelemetry({ sink = (record) => process.stdout.write(`${JSON.stringify(record)}\n`) } = {}) {
  const metrics = new Map();
  const emit = (level, event, fields = {}) => sink({ at: new Date().toISOString(), level, event, ...fields });
  return {
    runId() { return `run_${randomUUID()}`; },
    log(level, event, fields) { emit(level, event, fields); },
    increment(name, value = 1) { metrics.set(name, (metrics.get(name) ?? 0) + value); emit('debug', 'metric.increment', { name, value }); },
    observe(name, value) { const current = metrics.get(name) ?? { count: 0, total: 0, max: 0 }; current.count += 1; current.total += value; current.max = Math.max(current.max, value); metrics.set(name, current); },
    snapshot() { return Object.fromEntries(metrics); },
    async span(name, fields, operation) { const started = Date.now(); try { const result = await operation(); emit('info', 'span.completed', { name, ...fields, durationMs: Date.now() - started }); return result; } catch (error) { emit('error', 'span.failed', { name, ...fields, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }); throw error; } },
  };
}
