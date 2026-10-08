/**
 * backend/agent/multi-agent.mjs — Real Multi-Agent Orchestration.
 *
 * This is a SECOND execution strategy for an agent run, built ON TOP of the
 * EXISTING dynamic planner (`phase2-core/platform.mjs`): it reuses
 * `TaskGraph.fromGoal` to decompose a goal into a validated DAG of specialist
 * sub-tasks and `executeTaskGraph` to run them in conflict-checked parallel
 * batches with bounded retry/replan. It rebuilds nothing:
 *
 *   - the DAG + scheduler + conflict detection come from `executeTaskGraph`;
 *   - every specialist agent uses the SAME tool catalog (`agent/catalog.mjs`)
 *     and the SAME live tool registry the single-agent loop uses;
 *   - the SAME model router (passed in as `llm`) is used for every turn;
 *   - the SAME evidence ledger / event stream is written through injected
 *     `emit` / `evidence` sinks (so multi-agent runs are audited identically).
 *
 * Each TaskGraph node `kind` (intelligence / planning / implementation /
 * verification / browser / retrieval / report) is mapped to a focused agent
 * ROLE with its own system prompt and an allow-listed subset of tools. A role
 * agent is a real bounded agent loop: it asks the routed model for the next
 * tool call, executes it through the shared registry, records evidence, and
 * repeats until it returns a final text result or exhausts its turn budget.
 *
 * Security is preserved: a DANGEROUS tool is refused unless it was explicitly
 * approved for the run (`approvedTools`), exactly like the single-agent loop.
 */

import { TaskGraph, executeTaskGraph, summarizeTaskGraph } from '../../phase2-core/platform.mjs';
import { TOOL_BY_ID, DANGEROUS_TOOLS, fromProviderToolName } from './catalog.mjs';
import { requiresApproval } from './safety.mjs';

function addUsage(a = {}, b = {}) {
  return {
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
  };
}

// Specialist agent roles, keyed by the TaskGraph node `kind` produced by
// `TaskGraph.fromGoal`. Each role is a REAL agent: a focused system prompt plus
// an allow-listed subset of the SAME tool catalog the single-agent loop uses.
export const AGENT_ROLES = Object.freeze({
  intelligence: {
    id: 'analyst',
    name: 'Analyst Agent',
    tools: ['files.scan', 'code.analyze', 'code.impact', 'code.reason', 'web.extract', 'doc.extract', 'memory.search', 'git.status', 'git.diff', 'git.log', 'github.repo', 'github.issues.list', 'github.ci.status'],
    system: 'You are the ANALYST agent in a multi-agent team. Inspect the project and produce a factual map of the codebase (files, symbols, dependencies, risks). Use at most one tool call per turn from your allow-list. Never invent files, symbols or results. When you have enough evidence, return a concise factual summary as text.',
  },
  planning: {
    id: 'planner',
    name: 'Planner Agent',
    tools: ['code.reason', 'code.changeset', 'files.read', 'memory.search', 'code.review', 'git.diff', 'git.log'],
    system: 'You are the PLANNER agent. Turn the goal and the analyst findings into a concrete, verifiable plan. Use read-only tools only. Never invent facts. Return the plan as text when done.',
  },
  implementation: {
    id: 'implementer',
    name: 'Implementer Agent',
    tools: ['files.read', 'files.write', 'files.patch', 'workspace.apply', 'git.checkpoint'],
    system: 'You are the IMPLEMENTER agent. Make the smallest safe change that satisfies the plan. Prefer files.patch over files.write. Never touch secrets, authentication, policy or permissions. Return a summary of the exact change when done.',
  },
  verification: {
    id: 'verifier',
    name: 'Verifier Agent',
    tools: ['files.read', 'files.scan', 'code.analyze', 'terminal.run', 'code.run', 'git.diff', 'git.status', 'github.ci.status', 'code.review'],
    system: 'You are the VERIFIER agent. Independently verify the implementation with real evidence (run tests or read the changed files). Never claim a check you did not run. Return the verification result and the evidence when done.',
  },
  browser: {
    id: 'browser',
    name: 'Browser Agent',
    tools: ['browser.run'],
    system: 'You are the BROWSER agent. Drive the isolated browser to verify the page renders and the required checks pass. Return the verification result with the captured evidence when done.',
  },
  retrieval: {
    id: 'retrieval',
    name: 'Retrieval Agent',
    tools: ['code.reason', 'files.read', 'memory.search', 'memory.write', 'web.extract', 'doc.extract'],
    system: 'You are the RETRIEVAL agent. Retrieve the most relevant existing context from the project for the goal, and persist durable findings to project memory. Return the retrieved context as text when done.',
  },
  delivery: {
    id: 'delivery',
    name: 'Delivery Agent',
    tools: ['git.status', 'git.log', 'git.checkpoint', 'github.ci.status', 'github.issue.create', 'github.issue.comment', 'github.pr.create'],
    system: 'You are the DELIVERY agent. Ship the verified change: create a checkpoint, open a pull request, and read the CI status. Never push to a protected branch. Return the delivery result (PR url, CI state) as text when done.',
  },
  report: {
    id: 'reporter',
    name: 'Reporter Agent',
    tools: [],
    system: "You are the REPORTER agent. Compile a concise final report from the team's findings and evidence. Mention limitations and never invent. Return the report as text.",
  },
  task: {
    id: 'generalist',
    name: 'Generalist Agent',
    tools: ['files.scan', 'files.read', 'code.analyze', 'web.extract', 'doc.extract', 'memory.search'],
    system: 'You are a GENERALIST agent. Complete the assigned sub-task using your allow-list. Return the result as text when done.',
  },
});

/** The role that handles a TaskGraph node kind (never undefined). */
export function roleForKind(kind) {
  return AGENT_ROLES[kind] ?? AGENT_ROLES.task;
}

// Preference order used when a node's primary role has NO usable capability (all
// of its allow-listed tools are unavailable): fall back to a role whose tools ARE
// available so a run degrades gracefully instead of failing on a missing tool.
const ROLE_FALLBACK_ORDER = Object.freeze(['task', 'retrieval', 'intelligence', 'planning', 'verification', 'implementation', 'delivery', 'report']);

/**
 * Capability-aware role assignment. Starts from the node's kind-specific role and
 * keeps it whenever at least one of its tools is available (or the role needs no
 * tools, e.g. the reporter). Otherwise it picks the first fallback role that has
 * an available tool. When `availableTools` is not provided the behaviour is
 * EXACTLY `roleForKind(kind)` (so nothing changes for existing callers).
 */
export function selectRoleForNode(node, { availableTools } = {}) {
  const primary = roleForKind(node?.kind);
  if (!(availableTools instanceof Set)) return primary;
  const usable = (role) => role.tools.length === 0 || role.tools.some((toolId) => availableTools.has(toolId));
  if (usable(primary)) return primary;
  for (const key of ROLE_FALLBACK_ORDER) {
    const role = AGENT_ROLES[key];
    if (role && usable(role)) return role;
  }
  return primary;
}

/** OpenAI-format tool schemas for a role's allow-list (reuses the catalog). */
export function roleToolSchemas(role) {
  return (role?.tools ?? [])
    .map((toolId) => TOOL_BY_ID.get(toolId))
    .filter(Boolean)
    .map((tool) => ({ type: 'function', function: { name: tool.id.replaceAll('.', '__'), description: tool.description, parameters: tool.parameters } }));
}

/**
 * A bounded, shared context/evidence bus for the team. Every completed specialist
 * node publishes a compact finding plus the evidence ids it produced; every other
 * node (including the terminal reporter) reads a bounded view of it. This is how
 * findings and artifacts flow between agents without re-passing the whole graph.
 */
export function createTeamBus({ maxFindings = 24, maxEvidence = 64 } = {}) {
  const findings = [];
  const evidence = [];
  const artifacts = [];
  return {
    publishFinding(finding) {
      if (!finding || typeof finding !== 'object') return;
      findings.push(finding);
      if (findings.length > maxFindings) findings.splice(0, findings.length - maxFindings);
    },
    publishEvidence(evidenceId, meta = {}) {
      if (!evidenceId) return;
      evidence.push({ id: evidenceId, ...meta });
      if (evidence.length > maxEvidence) evidence.splice(0, evidence.length - maxEvidence);
    },
    publishArtifact(artifact) {
      if (!artifact) return;
      artifacts.push(artifact);
      if (artifacts.length > maxEvidence) artifacts.splice(0, artifacts.length - maxEvidence);
    },
    view() {
      return {
        teamFindings: findings.map((finding) => ({ nodeId: finding.nodeId, kind: finding.kind, role: finding.role, summary: String(finding.text ?? '').slice(0, 1_200), tools: finding.tools ?? [] })),
        evidenceIds: evidence.map((item) => item.id),
        artifacts: artifacts.slice(-maxEvidence),
      };
    },
  };
}

/**
 * Build a multi-agent orchestrator.
 *
 * @param {object}   deps
 * @param {object}   deps.llm            Routed LLM (`complete({ model, messages, tools, signal })`).
 * @param {object}   deps.tools          Live tool registry (`run(toolId, args, context)`).
 * @param {Function} [deps.emit]         Event sink `(type, details)` -> writes run_events/audit_logs.
 * @param {Function} [deps.evidence]     Evidence sink `(toolId, args, result)` -> returns an evidence id.
 * @param {Function} [deps.costFor]      Cost estimator `(model, usage)` -> usd.
 * @param {number}   [deps.maxAttempts]  Per-node attempts before the node fails (default 2).
 * @param {number}   [deps.maxTurnsPerAgent] Tool turns per role agent (default 3).
 * @returns {Function} `orchestrate({ goal, run, task, workspaceRoot, engine, model, signal, context, approvedTools })`
 */
export function createMultiAgentOrchestrator({ llm, tools, emit, evidence, costFor = () => 0, maxAttempts = 2, maxTurnsPerAgent = 3, maxParallel = 4 } = {}) {
  if (!llm || typeof llm.complete !== 'function') throw new Error('MULTI_AGENT_LLM_REQUIRED');
  if (!tools || typeof tools.run !== 'function') throw new Error('MULTI_AGENT_TOOLS_REQUIRED');
  const emitEvent = typeof emit === 'function' ? emit : () => {};
  const recordEvidence = typeof evidence === 'function' ? evidence : () => null;

  // One specialist agent: a bounded tool-use loop scoped to the role's allow-list.
  async function runRole(role, node, graph, ctx) {
    const schemas = roleToolSchemas(role);
    const done = [];
    let usage = {};
    let cost = 0;
    const depSummaries = node.dependsOn
      .map((dependency) => graph.nodes.find((item) => item.id === dependency))
      .filter(Boolean)
      .map((item) => ({ kind: item.kind, status: item.status, result: item.result ?? null }));
    // Shared team context: a bounded view of every other agent's findings and the
    // evidence ids they produced, so a node (especially the terminal reporter)
    // synthesises over the WHOLE team's work, not only its direct dependencies.
    const team = ctx.bus?.view?.() ?? { teamFindings: [], evidenceIds: [], artifacts: [] };

    for (let turn = 0; turn < maxTurnsPerAgent; turn += 1) {
      const messages = [
        { role: 'system', content: role.system },
        {
          role: 'user',
          content: JSON.stringify({
            goal: ctx.goal,
            node: { id: node.id, title: node.title, kind: node.kind },
            dependencies: depSummaries,
            team,
            completed: done.map((item) => ({ toolId: item.toolId, ok: item.result.ok !== false, output: item.result.output, error: item.result.error })),
            instruction: turn === 0
              ? 'Decide the single best next tool call from your allow-list, or return your final result as text.'
              : 'Continue with one more tool call, or return your final result as text if you are done.',
          }),
        },
      ];
      const response = await llm.complete({ model: ctx.model, messages, ...(schemas.length ? { tools: schemas } : {}), signal: ctx.signal });
      usage = addUsage(usage, response?.usage);
      cost += Number(costFor(response?.routedModel || response?.model || ctx.model || 'router', response?.usage || {})) || 0;
      const call = response?.toolCalls?.[0];
      if (!call) return { role: role.id, text: response?.text ?? '', outputs: done, usage, cost, turns: turn + 1 };

      const toolId = fromProviderToolName(call.name);
      if (!role.tools.includes(toolId)) throw new Error(`AGENT_TOOL_NOT_ALLOWED:${role.id}:${toolId}`);
      // Fail closed on a tool the run was not explicitly approved for. Uses the
      // shared risk policy so destructive/external actions are gated identically
      // to the single-agent loop (and plugin dangerous tools stay gated too).
      if ((DANGEROUS_TOOLS.has(toolId) || requiresApproval(toolId)) && !ctx.approvedTools.has(toolId)) throw new Error(`AGENT_APPROVAL_REQUIRED:${toolId}`);
      const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
      let result;
      try {
        result = await tools.run(toolId, args, { run: ctx.run, task: ctx.task, workspaceRoot: ctx.workspaceRoot, engine: ctx.engine, model: ctx.model, signal: ctx.signal, llm });
      } catch (error) {
        result = { ok: false, output: null, error: error instanceof Error ? error.message : String(error) };
      }
      const evidenceId = recordEvidence(toolId, args, result);
      done.push({ toolId, args, result, evidenceId });
      // Publish this tool's evidence to the shared bus so other agents can cite it.
      ctx.bus?.publishEvidence?.(evidenceId, { nodeId: node.id, toolId, ok: result.ok !== false });
      emitEvent('multi_agent_tool_completed', { role: role.id, nodeId: node.id, toolId, ok: result.ok !== false, error: result.error, evidenceId });
      // A failed tool aborts the role agent so the graph's retry/replan can react.
      if (result.ok === false) throw new Error(result.error || `TOOL_FAILED:${toolId}`);
    }
    return { role: role.id, text: 'turn budget reached', outputs: done, usage, cost, turns: maxTurnsPerAgent };
  }

  return async function orchestrate({ goal, run, task, workspaceRoot, engine, model, signal, context = {}, approvedTools } = {}) {
    const approved = approvedTools instanceof Set ? approvedTools : new Set(approvedTools ?? []);
    // The DAG is built by the EXISTING dynamic planner — no bespoke scheduling.
    // Prefer a dynamic, model-driven decomposition; `decompose` transparently
    // falls back to the deterministic heuristic plan (`fromGoal`) when the model
    // is unavailable or its output is unusable, so behaviour never regresses.
    const graph = await TaskGraph.decompose(goal, context, { llm, model, signal });
    emitEvent('multi_agent_started', {
      goal,
      planSource: graph.planSource ?? 'heuristic',
      nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind, title: node.title, dependsOn: node.dependsOn })),
    });

    const outputs = [];
    let usage = {};
    let cost = 0;
    // Capability-aware role assignment: only roles whose tools are actually
    // available are eligible, so a missing connector degrades to a capable role
    // instead of failing the whole node. When the registry exposes no view, this
    // is exactly `roleForKind`.
    const availableTools = (() => {
      try {
        const view = typeof tools.view === 'function' ? tools.view() : null;
        if (view?.byId instanceof Map) return new Set(view.byId.keys());
      } catch { /* fall through to kind-only assignment */ }
      return null;
    })();
    const bus = createTeamBus();
    const runner = async (node, currentGraph) => {
      const role = selectRoleForNode(node, { availableTools });
      emitEvent('multi_agent_node_started', { nodeId: node.id, kind: node.kind, role: role.id, attempt: node.attempts });
      const result = await runRole(role, node, currentGraph, { goal, run, task, workspaceRoot, engine, model, signal, approvedTools: approved, bus });
      usage = addUsage(usage, result.usage);
      cost += result.cost;
      outputs.push({ nodeId: node.id, kind: node.kind, role: result.role, text: result.text, toolCalls: result.outputs.map((item) => ({ toolId: item.toolId, ok: item.result.ok !== false, evidenceId: item.evidenceId })) });
      // Publish this node's finding to the shared bus for the rest of the team.
      bus.publishFinding({ nodeId: node.id, kind: node.kind, role: result.role, text: result.text, tools: result.outputs.map((item) => item.toolId) });
      emitEvent('multi_agent_node_completed', { nodeId: node.id, role: result.role, tools: result.outputs.map((item) => item.toolId), turns: result.turns });
      return { role: result.role, text: result.text, outputs: result.outputs };
    };
    const replan = async (node, error) => {
      emitEvent('multi_agent_replanned', { nodeId: node.id, error: error instanceof Error ? error.message : String(error) });
    };

    // Parallel batches + conflict detection + bounded retry/replan — all from the
    // existing executor. `maxParallel` keeps concurrent agents (and therefore
    // concurrent model/tool calls) bounded.
    const result = await executeTaskGraph(graph, runner, { maxAttempts, replan, maxParallel });
    // Reconcile the team's outcomes into a single verdict instead of trusting the
    // first node that finished: counts, failed/pending nodes and whether every
    // completed node produced a result.
    const reconciliation = result.summary ?? summarizeTaskGraph(graph);
    // Final synthesis by the appropriate role: prefer the terminal reporter node's
    // text; otherwise fall back to the last completed node's text.
    const reportNode = graph.nodes.find((node) => node.kind === 'report' && node.status === 'completed');
    const lastCompleted = [...graph.nodes].reverse().find((node) => node.status === 'completed');
    const synthesis = reportNode?.result?.text ?? lastCompleted?.result?.text ?? null;
    emitEvent('multi_agent_reconciled', { consistent: reconciliation.consistent, completed: reconciliation.completed, failed: reconciliation.failed, missingResults: reconciliation.missingResults });
    emitEvent('multi_agent_finished', {
      ok: result.ok,
      completed: graph.nodes.filter((node) => node.status === 'completed').length,
      failed: graph.nodes.filter((node) => node.status === 'failed').map((node) => node.id),
      consistent: reconciliation.consistent,
    });

    return {
      ok: result.ok,
      graph: {
        id: graph.id,
        goal: graph.goal,
        planSource: graph.planSource ?? 'heuristic',
        nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind, title: node.title, status: node.status, dependsOn: node.dependsOn, attempts: node.attempts, role: selectRoleForNode(node, { availableTools }).id, ...(node.error ? { error: node.error } : {}) })),
      },
      events: result.events,
      outputs,
      usage,
      cost,
      reconciliation,
      synthesis,
    };
  };
}
