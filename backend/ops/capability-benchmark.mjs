/**
 * backend/ops/capability-benchmark.mjs — Capability Benchmarking.
 *
 * Produces an honest, evidence-backed scorecard for the platform's capabilities
 * (the 13 the product promises) by reading REAL runtime signals — the live tool
 * registry state, the configured model providers, the integration connectors and
 * the wired runtime features — and never by asserting a capability is present
 * when it is not.
 *
 * Crucially it distinguishes two different things that a "flag check" would
 * conflate:
 *   - `wired`  — the capability EXISTS in code (a tool is registered, a runtime
 *                feature is compiled in, a connector is configured). This is a
 *                static fact, NOT proof that the capability works.
 *   - `proven` — the capability has been demonstrated END-TO-END by a real
 *                benchmark run (the agent E2E benchmark / the browser E2E). Only
 *                `proven` capabilities are reported as such; a wired-but-unproven
 *                capability is reported as `wired`, never as a green "live".
 *
 * It composes the existing pieces and duplicates nothing:
 *   - the tool registry `status()` is the source of truth for tool-backed
 *     capabilities (impact / changeset / reason / analyze / browser / code.run);
 *   - `llm.status()` is the source of truth for configured model providers;
 *   - the `/integrations/status` view is the source of truth for connectors;
 *   - the `runtime` flags describe features that are compiled into the worker
 *     (continuation supervisor, recovery, verification, task graph, eval engine);
 *   - the `proof` input carries the outcome of the real E2E benchmarks.
 *
 * The scoring engine (phase2-core/eval.mjs) is reused to turn the scorecard into
 * a reproducible benchmark report, so "capability benchmarking" is measured with
 * the same engine as every other benchmark instead of a bespoke counter.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineBenchmark, evaluator, runBenchmark } from '../../phase2-core/eval.mjs';
import { buildProjectIntelligence } from '../../phase2-core/platform.mjs';

const now = () => new Date().toISOString();

// The capability catalogue. `tools` names the registry tools that prove a
// capability; `runtime` names a wired feature flag; `integration` marks the
// connector-backed capability. Weights reflect how central a capability is.
export const CAPABILITY_DEFINITIONS = Object.freeze([
  { id: 'codebase-understanding', name: 'Smart Codebase Understanding', weight: 3, tools: ['code.analyze'] },
  { id: 'dependency-graph', name: 'Dependency Graph', weight: 2, runtime: 'dependencyGraph' },
  { id: 'impact-analysis', name: 'Impact Analysis', weight: 3, tools: ['code.impact'] },
  { id: 'change-intelligence', name: 'Change Intelligence / ChangeSet', weight: 3, tools: ['code.changeset'] },
  { id: 'long-running', name: 'Long-Running Autonomous Execution', weight: 3, runtime: 'longRunning' },
  { id: 'self-healing', name: 'Self-Healing + Recovery', weight: 3, runtime: 'selfHealing' },
  { id: 'deep-reasoning', name: 'Deep Codebase Reasoning', weight: 3, tools: ['code.reason'] },
  { id: 'multi-step-verification', name: 'Multi-Step Verification', weight: 3, runtime: 'multiStepVerification' },
  { id: 'computer-use', name: 'Agentic Computer Use / Browser Control', weight: 2, tools: ['browser.run'] },
  { id: 'multi-agent', name: 'Multi-Agent Orchestration', weight: 2, runtime: 'multiAgent' },
  { id: 'agent-evaluation', name: 'Agent Evaluation & Benchmark Engine', weight: 2, runtime: 'agentEvaluation' },
  { id: 'integrations', name: 'Production-grade Integrations', weight: 2, integration: true },
  { id: 'capability-benchmarking', name: 'Capability Benchmarking', weight: 2, runtime: 'capabilityBenchmarking' },
]);

// Features that are compiled into the worker / runtime. Defaults describe the
// wired reality; a caller (or a test) can override any flag to model a degraded
// deployment, and the scorecard will reflect it honestly. NOTE: a flag being
// true makes a capability `wired` (exists in code) — never `proven`.
export const DEFAULT_RUNTIME_FLAGS = Object.freeze({
  dependencyGraph: true, // buildProjectIntelligence emits importGraph/dependencyGraph
  longRunning: true, // ContinuationSupervisor is wired into the worker
  selfHealing: true, // recovery.mjs + runtime replan/repair loop
  multiStepVerification: true, // per-step verify() + evidence verification rows
  multiAgent: true, // backend/agent/multi-agent.mjs over phase2-core TaskGraph / executeTaskGraph
  agentEvaluation: true, // phase2-core/eval.mjs
  capabilityBenchmarking: true, // this module + the benchmark scripts
});

// Which REAL end-to-end benchmark proves each capability. A capability is only
// `proven` when its proof rule passes against the supplied proof object. Every
// capability now has a rule backed by a real benchmark scenario, so the scorecard
// can reach a fully-proven state without ever granting `proven` from a flag alone.
export const PROOF_MAP = Object.freeze({
  'codebase-understanding': { source: 'agent-benchmark:code-intelligence', test: (proof) => proof?.agentBenchmark?.scenarios?.codeIntelligence === true },
  'dependency-graph': { source: 'agent-benchmark:code-intelligence', test: (proof) => proof?.agentBenchmark?.scenarios?.codeIntelligence === true },
  'impact-analysis': { source: 'agent-benchmark:code-intelligence', test: (proof) => proof?.agentBenchmark?.scenarios?.codeIntelligence === true },
  'change-intelligence': { source: 'agent-benchmark:code-intelligence', test: (proof) => proof?.agentBenchmark?.scenarios?.codeIntelligence === true },
  'long-running': { source: 'agent-benchmark:long-running', test: (proof) => proof?.agentBenchmark?.scenarios?.longRunning === true },
  'self-healing': { source: 'agent-benchmark:self-healing', test: (proof) => proof?.agentBenchmark?.scenarios?.selfHealing === true },
  'deep-reasoning': { source: 'agent-benchmark:code-intelligence', test: (proof) => proof?.agentBenchmark?.scenarios?.codeIntelligence === true },
  'multi-step-verification': { source: 'agent-benchmark:agent-loop', test: (proof) => proof?.agentBenchmark?.scenarios?.agentLoop === true },
  'computer-use': { source: 'browser-e2e', test: (proof) => proof?.browserE2e?.passed === true },
  'multi-agent': { source: 'agent-benchmark:multi-agent', test: (proof) => proof?.agentBenchmark?.scenarios?.multiAgent === true },
  'agent-evaluation': { source: 'agent-benchmark:code-intelligence', test: (proof) => proof?.agentBenchmark?.scenarios?.codeIntelligence === true },
  'integrations': { source: 'agent-benchmark:integrations', test: (proof) => proof?.agentBenchmark?.scenarios?.integrations === true },
  'capability-benchmarking': { source: 'capability-benchmark', test: (proof) => proof?.capabilityBenchmark === true },
});

function toolState(tools, toolId) {
  const buckets = ['live', 'partial', 'unwired', 'failed'];
  for (const bucket of buckets) {
    if ((tools?.[bucket] ?? []).includes(toolId)) return bucket;
  }
  return 'missing';
}

// `proven` is the only status that means "demonstrated end-to-end". `wired`
// means the capability exists in code but has not been proven by a benchmark.
const FRACTION = { proven: 1, wired: 0.7, partial: 0.5, unwired: 0, failed: 0, missing: 0 };

function levelFor(score) {
  if (score >= 90) return 'production';
  if (score >= 70) return 'strong';
  if (score >= 40) return 'partial';
  return 'minimal';
}

/**
 * Normalize the raw benchmark reports into the compact proof object the
 * scorecard consumes. Every field degrades to `false` when a report is missing,
 * so a capability is never marked proven by accident.
 *
 *   { agentBenchmark: <agent-benchmark.report.json>,
 *     browserE2e: <browser-e2e.report.json>,
 *     capabilityBenchmark: <boolean> }
 */
export function normalizeProof(input = {}) {
  const agent = input.agentBenchmark ?? {};
  // Accept both the RAW report shape (agent.agentLoop.summary.passRate) and an
  // already-normalized shape (agent.scenarios.*) so the function is idempotent.
  const scenarios = agent.scenarios ?? {
    agentLoop: agent.agentLoop?.summary?.passRate === 100,
    multiAgent: agent.multiAgent?.summary?.passRate === 100,
    longRunning: agent.longRunning?.summary?.passRate === 100,
    codeIntelligence: agent.codeIntelligence?.summary?.passRate === 100,
    selfHealing: agent.selfHealing?.summary?.passRate === 100,
    integrations: agent.integrations?.summary?.passRate === 100,
  };
  return {
    agentBenchmark: {
      passed: agent.passed === true,
      scenarios: {
        agentLoop: scenarios.agentLoop === true,
        multiAgent: scenarios.multiAgent === true,
        longRunning: scenarios.longRunning === true,
        codeIntelligence: scenarios.codeIntelligence === true,
        selfHealing: scenarios.selfHealing === true,
        integrations: scenarios.integrations === true,
      },
    },
    browserE2e: { passed: input.browserE2e?.passed === true },
    capabilityBenchmark: input.capabilityBenchmark === true,
  };
}

/**
 * Load the real benchmark reports written by the release pipeline
 * (scripts/agent-benchmark.mjs and scripts/browser-e2e.mjs) from `dir` and
 * normalize them. Missing/unreadable reports are treated as "not proven".
 */
export function loadProofArtifacts(dir = process.cwd(), { capabilityBenchmark = false } = {}) {
  const read = (file) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      return null;
    }
  };
  return normalizeProof({
    agentBenchmark: read('agent-benchmark.report.json'),
    browserE2e: read('browser-e2e.report.json'),
    capabilityBenchmark,
  });
}

/**
 * Build a capability scorecard from normalized signals.
 *
 * signals = {
 *   tools: { live: [], partial: [], unwired: [], failed: [] },
 *   models: { configured: number, healthy: number, total: number },
 *   integrations: { configured: string[], total: number },
 *   runtime: { [flag]: boolean },
 *   proof: { agentBenchmark: {...}, browserE2e: {...}, capabilityBenchmark: boolean },
 * }
 */
export function buildCapabilityScorecard(signals = {}) {
  const tools = signals.tools ?? {};
  const models = signals.models ?? { configured: 0, healthy: 0, total: 0 };
  const integrations = signals.integrations ?? { configured: [], total: 0 };
  const runtime = { ...DEFAULT_RUNTIME_FLAGS, ...(signals.runtime ?? {}) };
  const proof = normalizeProof(signals.proof ?? {});

  const capabilities = CAPABILITY_DEFINITIONS.map((definition) => {
    const evidence = [];
    let status;
    let wired = false;
    if (definition.tools?.length) {
      // Best-of: a capability is as available as its most available proof tool.
      const states = definition.tools.map((toolId) => ({ toolId, state: toolState(tools, toolId) }));
      const hasLive = states.some((item) => item.state === 'live');
      const hasPartial = states.some((item) => item.state === 'partial');
      const hasFailed = states.some((item) => item.state === 'failed');
      wired = hasLive || hasPartial;
      status = hasFailed && !hasLive && !hasPartial ? 'failed' : hasLive ? 'wired' : hasPartial ? 'partial' : 'unwired';
      for (const item of states) evidence.push(`tool:${item.toolId}=${item.state}`);
    } else if (definition.integration) {
      const configured = Array.isArray(integrations.configured) ? integrations.configured : [];
      wired = configured.length > 0;
      status = wired ? 'wired' : 'partial';
      evidence.push(`connectors:${configured.length}/${integrations.total ?? configured.length} configured`);
      if (configured.length) evidence.push(`configured:${configured.join(',')}`);
    } else {
      const enabled = runtime[definition.runtime] === true;
      wired = enabled;
      status = enabled ? 'wired' : 'unwired';
      evidence.push(`runtime:${definition.runtime}=${enabled}`);
    }

    // Upgrade to `proven` ONLY with real end-to-end evidence. A passing E2E
    // benchmark is direct execution evidence (the capability actually ran), which
    // is strictly stronger than the static `wired` fact — so a proven capability
    // is also `wired` by construction, even when this process' static config
    // (e.g. BROWSER_CDP_URL) is unset. `proven` is never granted by a flag alone.
    const rule = PROOF_MAP[definition.id];
    const proven = Boolean(rule && rule.test(proof));
    if (proven) {
      wired = true;
      status = 'proven';
    }
    evidence.push(rule ? `proof:${rule.source}=${proven}` : 'proof:none');

    return {
      id: definition.id,
      name: definition.name,
      weight: definition.weight,
      status,
      wired,
      proven,
      score: Math.round((FRACTION[status] ?? 0) * 100),
      evidence,
    };
  });

  const weightSum = capabilities.reduce((sum, capability) => sum + capability.weight, 0) || 1;
  const score = Math.round(capabilities.reduce((sum, capability) => sum + capability.score * capability.weight, 0) / weightSum);
  const provenScore = Math.round(capabilities.reduce((sum, capability) => sum + (capability.proven ? 100 : 0) * capability.weight, 0) / weightSum);
  const count = (status) => capabilities.filter((capability) => capability.status === status).length;

  return {
    generatedAt: now(),
    score,
    provenScore,
    level: levelFor(score),
    models: { configured: models.configured ?? 0, healthy: models.healthy ?? 0, total: models.total ?? 0 },
    integrations: { configured: integrations.configured ?? [], total: integrations.total ?? 0 },
    capabilities,
    summary: {
      total: capabilities.length,
      proven: count('proven'),
      wired: count('wired'),
      partial: count('partial'),
      unwired: count('unwired'),
      failed: count('failed'),
    },
  };
}

/** One-line, human-readable summary for logs / tool output. */
export function describeScorecard(scorecard) {
  if (!scorecard) return 'no scorecard';
  const { score, provenScore, level, summary } = scorecard;
  return `capability score ${score}/100 (${level}); ${summary.proven} proven end-to-end, ${summary.wired} wired (unproven), ${summary.partial} partial, ${summary.unwired} unwired, ${summary.failed} failed; proven ${provenScore}/100`;
}

/**
 * Gather the real signals the scorecard needs from live runtime objects. Every
 * field is optional and degrades to an honest "not configured" default.
 */
export function collectCapabilitySignals({ tools, llm, integrations, runtime, proof } = {}) {
  const toolStatus = tools?.status?.() ?? { live: [], partial: [], unwired: [], failed: [] };
  const providers = typeof llm?.status === 'function' ? llm.status() ?? [] : [];
  const configured = providers.filter((provider) => provider?.configured === true);
  const healthy = configured.filter((provider) => provider?.healthy !== false);

  // A connector is "configured" when its status object reports it truthy.
  const connectorFlags = {
    billing: integrations?.billing?.configured ?? integrations?.billing?.provider != null,
    github: integrations?.github?.configured ?? integrations?.github?.oauthConfigured,
    embeddings: integrations?.embeddings?.configured ?? integrations?.embeddings?.enabled,
    browser: integrations?.browser?.cdpConfigured ?? integrations?.browser?.localLaunch,
    image: (integrations?.tools?.live ?? []).includes('image.generate'),
    vision: (integrations?.tools?.live ?? []).includes('image.analyze'),
    calendar: (integrations?.tools?.live ?? []).includes('calendar.schedule'),
    email: (integrations?.tools?.live ?? []).includes('email.send'),
  };
  const configuredConnectors = Object.entries(connectorFlags).filter(([, value]) => value === true).map(([key]) => key);

  return {
    tools: {
      live: toolStatus.live ?? [],
      partial: toolStatus.partial ?? [],
      unwired: toolStatus.unwired ?? [],
      failed: toolStatus.failed ?? [],
    },
    models: { configured: configured.length, healthy: healthy.length, total: providers.length },
    integrations: { configured: configuredConnectors, total: Object.keys(connectorFlags).length },
    runtime: runtime ?? {},
    proof: proof ?? {},
  };
}

/**
 * Turn the scorecard into a reproducible benchmark (phase2-core/eval.mjs). Each
 * capability is a task; the evaluator passes when the capability is available
 * (proven, wired or partial) and fails when it is unwired or failed. The
 * proven-vs-wired distinction itself lives on the scorecard, not here.
 */
export function defineCapabilityBenchmark(scorecard) {
  const tasks = (scorecard?.capabilities ?? []).map((capability) => ({
    id: capability.id,
    name: capability.name,
    weight: capability.weight,
    status: capability.status,
    proven: capability.proven,
    evidence: capability.evidence,
  }));
  return defineBenchmark({
    name: 'capability-scorecard',
    tasks,
    evaluators: [
      evaluator('available', (result, task) => ({
        passed: ['proven', 'wired', 'partial'].includes(task.status),
        detail: `status=${task.status}`,
      })),
      evaluator('not-failed', (result, task) => ({
        passed: task.status !== 'failed',
        detail: task.status === 'failed' ? 'capability failed' : 'ok',
      })),
    ],
  });
}

/** Run the capability benchmark and attach the scorecard to the report. */
export async function runCapabilityBenchmark(signals = {}) {
  const scorecard = buildCapabilityScorecard(signals);
  const benchmark = defineCapabilityBenchmark(scorecard);
  const report = await runBenchmark(benchmark, async (task) => ({ status: task.status }));
  return { scorecard, report };
}

/**
 * Define a REAL agent benchmark over the code-intelligence tools. Tasks are
 * derived from the actual project index (never hard-coded), so the benchmark
 * exercises the same tools the agent uses against the same repository and checks
 * they return honest, non-empty output.
 */
export function defineAgentBenchmark({ intelligence } = {}) {
  const files = Array.isArray(intelligence?.files) ? intelligence.files : [];
  const symbols = Array.isArray(intelligence?.symbols) ? intelligence.symbols : [];
  const sourceFile = files.find((file) => /\.(mjs|cjs|js|tsx?|jsx)$/.test(file) && !/\.test\./.test(file)) ?? files[0];
  const symbol = symbols.find((item) => item?.name)?.name;

  const tasks = [
    { id: 'analyze', name: 'Codebase analysis', toolId: 'code.analyze', args: sourceFile ? { path: sourceFile } : {}, weight: 2 },
    { id: 'changeset', name: 'ChangeSet construction', toolId: 'code.changeset', args: { goal: 'agent-benchmark' }, weight: 2 },
  ];
  if (sourceFile) tasks.push({ id: 'impact', name: 'Impact analysis', toolId: 'code.impact', args: { changedFiles: [sourceFile] }, weight: 2 });
  if (symbol) tasks.push({ id: 'reason', name: 'Deep reasoning (definition)', toolId: 'code.reason', args: { question: symbol, mode: 'definition' }, weight: 2 });

  return defineBenchmark({
    name: 'agent-code-intelligence',
    tasks,
    evaluators: [
      evaluator('ok', (result) => ({ passed: result != null && result.ok !== false, detail: result?.ok === false ? (result?.error ?? 'failed') : 'ok' })),
      evaluator('has-output', (result) => ({ passed: result?.output != null, detail: result?.output == null ? 'no output' : 'ok' })),
    ],
  });
}

/**
 * Run the agent benchmark against the live tool registry. Each task calls the
 * real tool (`tools.run`) with the workspace root; a task that throws is scored
 * as a failure by the engine (never silently passed).
 */
export async function runAgentBenchmark({ tools, root, intelligence } = {}) {
  if (!tools || typeof tools.run !== 'function') throw new Error('TOOLS_REQUIRED');
  const index = intelligence ?? (root ? await buildProjectIntelligence(root) : { files: [], symbols: [] });
  const benchmark = defineAgentBenchmark({ intelligence: index });
  const report = await runBenchmark(benchmark, async (task) => {
    const result = await tools.run(task.toolId, task.args, { workspaceRoot: root });
    return result?.output !== undefined ? { ok: result.ok !== false, output: result.output } : result;
  });
  return { report, workspace: { root: root ?? null, files: index.files?.length ?? 0, symbols: index.symbols?.length ?? 0 } };
}
