#!/usr/bin/env node
/**
 * scripts/agent-benchmark.mjs — End-to-End Agent Benchmark (real).
 *
 * Runs the REAL agent stack end-to-end over a throwaway workspace, then scores
 * the outcome with the SAME engine the rest of the platform uses
 * (phase2-core/eval.mjs). Every scenario goes through the real HTTP API ->
 * RunQueue -> agent runtime -> tools -> evidence ledger -> verification path:
 *
 *   1. agent-loop      — the single-agent planner -> tool -> verify -> final loop
 *   2. multi-agent     — the TaskGraph of specialist agents (payload.multiAgent)
 *   3. long-running    — a bounded wall-clock stop that checkpoints and is
 *                        transparently resumed by the ContinuationSupervisor
 *   4. code-intelligence — the code-intelligence agent benchmark
 *                        (backend/ops/capability-benchmark.mjs) over the real index
 *   5. self-healing    — a step whose FIRST tool call fails, is diagnosed by the
 *                        real recovery loop, repaired, and then succeeds
 *   6. integrations    — a REAL `email.send` tool call delivered over a local
 *                        HTTP connector (EMAIL_PROVIDER=webhook) and reported
 *                        `live` by the live tool registry
 *
 * Nothing is mocked except the LLM: the planner is deterministic so the
 * benchmark is reproducible without network or API keys, while still exercising
 * the real planner -> tool -> verification -> final-synthesis path (and, for the
 * long-running scenario, a real wall-clock budget stop + continuation).
 *
 * Usage:
 *   node --experimental-sqlite scripts/agent-benchmark.mjs [--out report.json] [--keep]
 * Exit code is non-zero when the benchmark does not pass.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Database } from '../backend/db/client.mjs';
import { createApp } from '../backend/server.mjs';
import { RunQueue } from '../backend/queue/queue.mjs';
import { createLiveToolRegistry } from '../backend/tools/registry.mjs';
import { buildProjectIntelligence } from '../phase2-core/platform.mjs';
import { defineBenchmark, evaluator, runBenchmark } from '../phase2-core/eval.mjs';
import { runAgentBenchmark } from '../backend/ops/capability-benchmark.mjs';

const PASSWORD = 'correct horse battery staple';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const keep = process.argv.includes('--keep');
const outFile = arg('--out', path.join(REPO_ROOT, 'agent-benchmark.report.json'));

// Bound the continuation chain to a single hop so the long-running scenario is
// fast and deterministic (the supervisor reads this at construction time).
process.env.AGENT_MAX_CONTINUATIONS = process.env.AGENT_MAX_CONTINUATIONS || '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A deterministic, offline model. It answers every prompt the REAL agent stack
// issues — the single-agent planner/step/final prompts AND the multi-agent role
// prompts — so the full loop runs without a network or API keys.
function deterministicLLM({ plannerDelayMs = 0 } = {}) {
  let delay = plannerDelayMs;
  const usage = (promptTokens, completionTokens) => ({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens });
  const toolCall = (name, args) => ({ provider: 'benchmark', text: '', toolCalls: [{ id: `call_${name}`, name, arguments: args }], usage: usage(8, 16) });
  return {
    setPlannerDelay(ms) { delay = Math.max(0, Number(ms) || 0); },
    status: () => [{ id: 'benchmark', configured: true }],
    async complete({ messages = [] } = {}) {
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      const user = messages.find((message) => message.role === 'user')?.content ?? '';
      // --- Recovery re-plan (checked BEFORE the planner branch: the recovery
      // prompt embeds the planner prompt plus a "previous step FAILED" note) ---
      if (system.includes('A previous step FAILED')) {
        return {
          provider: 'benchmark',
          text: JSON.stringify({
            reasoning: 'Route around the failed step with a safe read of the known file.',
            steps: [{ id: 'recovery_1', title: 'Read app.js instead', toolId: 'files.read', args: { path: 'app.js' } }],
          }),
          toolCalls: [],
          usage: usage(8, 16),
        };
      }
      // --- Self-healing diagnosis: the real runtime asks the model to repair a
      // failed tool call. The repair points the read at a file that exists. ---
      if (system.includes('Diagnose the failed tool call')) {
        return { provider: 'benchmark', text: JSON.stringify({ action: 'retry', args: { path: 'app.js' } }), toolCalls: [], usage: usage(6, 12) };
      }
      // --- Single-agent planner (goal-scoped so each scenario plans its own work) ---
      if (system.includes('secure planner')) {
        if (delay) await sleep(delay);
        const steps = system.includes('SELF_HEAL')
          ? [
              { id: 'step_1', title: 'Read the missing input', toolId: 'files.read', args: { path: 'missing-input.txt' } },
              { id: 'step_2', title: 'Analyze app.js', toolId: 'code.analyze', args: { path: 'app.js' } },
            ]
          : system.includes('INTEGRATE')
            ? [
                { id: 'step_1', title: 'Read app.js', toolId: 'files.read', args: { path: 'app.js' } },
                { id: 'step_2', title: 'Email the summary', toolId: 'email.send', args: { to: 'ops@example.com', subject: 'Benchmark integration proof', body: 'delivered by the live email connector' } },
              ]
            : [
                { id: 'step_1', title: 'Scan workspace', toolId: 'files.scan', args: { scope: '.', maxFiles: 50 } },
                { id: 'step_2', title: 'Analyze app.js', toolId: 'code.analyze', args: { path: 'app.js' } },
              ];
        return {
          provider: 'benchmark',
          text: JSON.stringify({ reasoning: 'Gather evidence with the allowed tools.', steps }),
          toolCalls: [],
          usage: usage(12, 24),
        };
      }
      if (system.includes('Execute one planned step')) {
        return { provider: 'benchmark', text: '', toolCalls: [], usage: usage(4, 2) };
      }
      // --- Multi-agent specialist role agents (one tool call, then a final text) ---
      if (/You are the (ANALYST|PLANNER|IMPLEMENTER|VERIFIER|BROWSER|RETRIEVAL|REPORTER|GENERALIST) agent/.test(system)) {
        let parsed = {};
        try { parsed = JSON.parse(user); } catch { /* ignore a non-JSON turn */ }
        const kind = parsed?.node?.kind;
        const completed = Array.isArray(parsed?.completed) ? parsed.completed : [];
        if (completed.length === 0) {
          if (kind === 'intelligence') return toolCall('files__scan', { scope: '.', maxFiles: 50 });
          if (kind === 'implementation') return toolCall('files__read', { path: 'app.js' });
          if (kind === 'verification') return toolCall('code__analyze', { path: 'app.js' });
          if (kind === 'retrieval') return toolCall('files__read', { path: 'app.js' });
        }
        return { provider: 'benchmark', text: `${kind} agent finished`, toolCalls: [], usage: usage(6, 10) };
      }
      // --- Final synthesis ---
      return { provider: 'benchmark', text: 'تم فحص مساحة العمل وتحليل الملف بنجاح مع دليل من الأدوات.', toolCalls: [], usage: usage(10, 8) };
    },
  };
}

async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-agent-bench-'));
  await mkdir(path.join(dir, 'lib'), { recursive: true });
  await writeFile(path.join(dir, 'lib', 'util.js'), 'export const double = (n) => n * 2;\nexport function greet(name) { return `hi ${name}`; }\n', 'utf8');
  await writeFile(path.join(dir, 'app.js'), "import { double, greet } from './lib/util.js';\nexport const run = () => greet(double(21));\n", 'utf8');
  await mkdir(path.join(dir, 'test'), { recursive: true });
  await writeFile(path.join(dir, 'test', 'app.test.js'), "import { run } from '../app.js';\nif (run() !== 'hi 42') process.exit(1);\n", 'utf8');
  return dir;
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const TERMINAL = ['completed', 'failed', 'unverified', 'blocked', 'completed_with_warnings'];

// Score the real single-agent loop outcome with the shared eval engine.
function agentLoopBenchmark() {
  return defineBenchmark({
    name: 'agent-loop',
    tasks: [{ id: 'scan-and-analyze', name: 'Plan -> tool -> verify -> final', weight: 1 }],
    evaluators: [
      evaluator('completed', (result) => ({ passed: result?.status === 'completed', detail: `status=${result?.status}` })),
      evaluator('has-evidence', (result) => ({ passed: (result?.evidenceCount ?? 0) > 0, detail: `evidence=${result?.evidenceCount ?? 0}` })),
      evaluator('has-final', (result) => ({ passed: typeof result?.final === 'string' && result.final.length > 0, detail: result?.final ? 'ok' : 'no final answer' })),
      evaluator('tools-ran', (result) => ({ passed: (result?.toolResultEvents ?? 0) >= 2, detail: `tool_completed=${result?.toolResultEvents ?? 0}` })),
    ],
  });
}

// Score the real multi-agent (TaskGraph of specialists) outcome.
function multiAgentBenchmark() {
  return defineBenchmark({
    name: 'multi-agent',
    tasks: [{ id: 'specialist-dag', name: 'TaskGraph of specialist agents with real tools + evidence', weight: 1 }],
    evaluators: [
      evaluator('completed', (result) => ({ passed: result?.status === 'completed', detail: `status=${result?.status}` })),
      evaluator('multi-agent-flag', (result) => ({ passed: result?.multiAgent === true, detail: `multiAgent=${result?.multiAgent}` })),
      evaluator('graph-nodes', (result) => ({ passed: (result?.graphNodes ?? 0) >= 5, detail: `nodes=${result?.graphNodes ?? 0}` })),
      evaluator('nodes-completed', (result) => ({ passed: (result?.nodesCompleted ?? 0) >= 5, detail: `node_completed=${result?.nodesCompleted ?? 0}` })),
      evaluator('has-evidence', (result) => ({ passed: (result?.evidenceCount ?? 0) >= 3, detail: `evidence=${result?.evidenceCount ?? 0}` })),
    ],
  });
}

// Score the real long-running continuation outcome (bounded wall-clock stop).
function longRunningBenchmark() {
  return defineBenchmark({
    name: 'long-running',
    tasks: [{ id: 'continuation', name: 'bounded wall-clock -> checkpoint -> continuation', weight: 1 }],
    evaluators: [
      evaluator('continued-not-failed', (result) => ({ passed: result?.status === 'completed_with_warnings', detail: `status=${result?.status}` })),
      evaluator('continuation-scheduled', (result) => ({ passed: result?.continuation?.scheduled === true, detail: `scheduled=${result?.continuation?.scheduled}` })),
      evaluator('continuation-bounded', (result) => ({
        passed: result?.continuationContinuation?.scheduled === false && result?.continuationContinuation?.reason === 'continuation_limit_reached',
        detail: `reason=${result?.continuationContinuation?.reason}`,
      })),
    ],
  });
}

// Score the real self-healing outcome: a failing tool call is diagnosed,
// repaired, and the SAME tool then succeeds \u2014 all inside the real runtime.
function selfHealingBenchmark() {
  return defineBenchmark({
    name: 'self-healing',
    tasks: [{ id: 'repair', name: 'failing tool call -> diagnosis -> repair -> success', weight: 1 }],
    evaluators: [
      evaluator('completed', (result) => ({ passed: result?.status === 'completed', detail: `status=${result?.status}` })),
      evaluator('repair-recorded', (result) => ({ passed: (result?.repairEvents ?? 0) >= 1, detail: `repair_events=${result?.repairEvents ?? 0}` })),
      evaluator('failed-then-succeeded', (result) => ({
        passed: result?.failedRead === true && result?.repairedRead === true,
        detail: `failed_read=${result?.failedRead} repaired_read=${result?.repairedRead}`,
      })),
      evaluator('has-evidence', (result) => ({ passed: (result?.evidenceCount ?? 0) >= 2, detail: `evidence=${result?.evidenceCount ?? 0}` })),
      evaluator('has-final', (result) => ({ passed: typeof result?.final === 'string' && result.final.length > 0, detail: result?.final ? 'ok' : 'no final answer' })),
    ],
  });
}

// Score the real integrations outcome: a live `email.send` tool call performs a
// REAL HTTP round-trip to a local connector and the registry reports it live.
function integrationsBenchmark() {
  return defineBenchmark({
    name: 'integrations',
    tasks: [{ id: 'email-connector', name: 'live email.send delivered over a real connector', weight: 1 }],
    evaluators: [
      evaluator('completed', (result) => ({ passed: result?.status === 'completed', detail: `status=${result?.status}` })),
      evaluator('email-delivered', (result) => ({
        passed: (result?.deliveredCount ?? 0) >= 1 && (result?.deliveredTo ?? []).includes('ops@example.com'),
        detail: `delivered=${result?.deliveredCount ?? 0} to=${(result?.deliveredTo ?? []).join(',')}`,
      })),
      evaluator('email-tool-ok', (result) => ({ passed: result?.emailToolOk === true, detail: `email_tool_ok=${result?.emailToolOk}` })),
      evaluator('connector-live', (result) => ({ passed: result?.connectorLive === true, detail: `email.send live=${result?.connectorLive}` })),
      evaluator('has-evidence', (result) => ({ passed: (result?.evidenceCount ?? 0) >= 1, detail: `evidence=${result?.evidenceCount ?? 0}` })),
    ],
  });
}

async function main() {
  const workspace = await makeWorkspace();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-agent-bench-db-'));
  const db = new Database(path.join(dir, 'bench.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const llm = deterministicLLM();
  const tools = createLiveToolRegistry({ db, llm, getWorkspaceRoot: () => workspace });
  const app = createApp({ db, queue, llm, liveTools: tools });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`; // security-scan:allow private-url-literal (local loopback bind)
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const getRun = async (token, runId) => (await request(`/runs/${runId}`, { token })).body;
  const waitTerminal = (token, runId) => waitFor(async () => {
    const run = await getRun(token, runId);
    return TERMINAL.includes(run.status) ? run : null;
  });

  const report = { startedAt: new Date().toISOString(), workspace, steps: [] };
  const step = (name, data) => {
    report.steps.push({ name, ...data });
    process.stdout.write(`\n== ${name} ==\n${JSON.stringify(data, null, 2)}\n`);
  };

  let exitCode = 0;
  let emailServer = null;
  const emailReceived = [];
  try {
    const registered = await request('/auth/register', { method: 'POST', body: { email: 'bench@agent.test', password: PASSWORD, tenantName: 'Benchmark' } });
    const token = registered.body.session.token;
    const project = await request('/projects', { method: 'POST', token, body: { name: 'Benchmark project', rootPath: workspace } });
    step('setup', { register: registered.status, project: project.status, projectId: project.body.projectId });

    const goal = 'افحص مساحة العمل وحلّل ملف app.js';
    const enqueue = (body) => request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal, model: 'test', ...body } });

    queue.start();

    // ---- Scenario 1: single-agent loop ----
    const created = await enqueue({});
    step('enqueue agent.run', { status: created.status, runId: created.body.runId, taskId: created.body.taskId });
    if (created.status !== 202) throw new Error(`POST /runs failed: ${JSON.stringify(created.body)}`);
    const finished = await waitTerminal(token, created.body.runId);
    const loopResult = {
      status: finished.status,
      final: finished.result?.final ?? null,
      evidenceCount: (finished.evidence ?? []).length,
      toolResultEvents: (finished.events ?? []).filter((event) => event.type === 'tool_completed').length,
    };
    step('agent loop finished', loopResult);
    const loopReport = await runBenchmark(agentLoopBenchmark(), async () => loopResult);
    step('agent-loop benchmark', { summary: loopReport.summary });

    // ---- Scenario 2: multi-agent (TaskGraph of specialists) ----
    const maCreated = await enqueue({ multiAgent: true });
    step('enqueue multi-agent run', { status: maCreated.status, runId: maCreated.body.runId });
    if (maCreated.status !== 202) throw new Error(`POST /runs (multi-agent) failed: ${JSON.stringify(maCreated.body)}`);
    const maFinished = await waitTerminal(token, maCreated.body.runId);
    const multiAgentResult = {
      status: maFinished.status,
      multiAgent: maFinished.result?.multiAgent === true,
      graphNodes: (maFinished.result?.graph?.nodes ?? []).length,
      nodesCompleted: (maFinished.events ?? []).filter((event) => event.type === 'multi_agent_node_completed').length,
      evidenceCount: (maFinished.evidence ?? []).length,
    };
    step('multi-agent finished', multiAgentResult);
    const maReport = await runBenchmark(multiAgentBenchmark(), async () => multiAgentResult);
    step('multi-agent benchmark', { summary: maReport.summary });

    // ---- Scenario 3: long-running continuation (bounded wall-clock stop) ----
    llm.setPlannerDelay(600); // make the planning turn overrun the 150ms budget
    const lrCreated = await enqueue({ timeoutMs: 150 });
    step('enqueue long-running run', { status: lrCreated.status, runId: lrCreated.body.runId });
    if (lrCreated.status !== 202) throw new Error(`POST /runs (long-running) failed: ${JSON.stringify(lrCreated.body)}`);
    const lrFinished = await waitTerminal(token, lrCreated.body.runId);
    const continuationRunId = lrFinished.result?.continuation?.runId ?? null;
    // Keep the slow planner until the continuation run settles, then restore it.
    const continuation = continuationRunId ? await waitTerminal(token, continuationRunId) : null;
    llm.setPlannerDelay(0);
    const longRunningResult = {
      status: lrFinished.status,
      continuation: lrFinished.result?.continuation ?? null,
      continuationStatus: continuation?.status ?? null,
      continuationContinuation: continuation?.result?.continuation ?? null,
    };
    step('long-running finished', longRunningResult);
    const lrReport = await runBenchmark(longRunningBenchmark(), async () => longRunningResult);
    step('long-running benchmark', { summary: lrReport.summary });

    // ---- Scenario 4: code-intelligence agent benchmark over the SAME workspace ----
    const intelligence = await buildProjectIntelligence(workspace);
    const { report: ciReport, workspace: ciWorkspace } = await runAgentBenchmark({ tools, root: workspace, intelligence });
    step('code-intelligence benchmark', { workspace: ciWorkspace, summary: ciReport.summary, tasks: ciReport.tasks.map((task) => ({ id: task.id, ok: task.ok, score: task.score })) });

    // ---- Scenario 5: self-healing (real failing call -> diagnosis -> repair) ----
    const shCreated = await enqueue({ goal: 'SELF_HEAL: read the missing input then analyze app.js' });
    step('enqueue self-healing run', { status: shCreated.status, runId: shCreated.body.runId });
    if (shCreated.status !== 202) throw new Error(`POST /runs (self-healing) failed: ${JSON.stringify(shCreated.body)}`);
    const shFinished = await waitTerminal(token, shCreated.body.runId);
    const shToolEvents = (shFinished.events ?? [])
      .filter((event) => event.type === 'tool_completed')
      .map((event) => { try { return JSON.parse(event.payload_json); } catch { return {}; } });
    const shReads = shToolEvents.filter((event) => event.toolId === 'files.read');
    const selfHealingResult = {
      status: shFinished.status,
      final: shFinished.result?.final ?? null,
      selfHealingEvents: (shFinished.events ?? []).filter((event) => event.type === 'self_healing').length,
      repairEvents: (shFinished.events ?? []).filter((event) => event.type === 'self_healing' && String(event.payload_json).includes('"repair"')).length,
      readOutcomes: shReads.map((event) => event.ok === true),
      failedRead: shReads.some((event) => event.ok === false),
      repairedRead: shReads.some((event) => event.ok === true),
      toolResultEvents: shToolEvents.length,
      evidenceCount: (shFinished.evidence ?? []).length,
    };
    step('self-healing finished', selfHealingResult);
    const shReport = await runBenchmark(selfHealingBenchmark(), async () => selfHealingResult);
    step('self-healing benchmark', { summary: shReport.summary });

    // ---- Scenario 6: integrations (a live email.send over a real connector) ----
    emailServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(raw); } catch { /* ignore a non-JSON body */ }
        emailReceived.push(payload);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `msg-${emailReceived.length}` }));
      });
    });
    await new Promise((resolve) => emailServer.listen(0, '127.0.0.1', resolve));
    const emailPort = emailServer.address().port;
    process.env.EMAIL_PROVIDER = 'webhook';
    process.env.EMAIL_WEBHOOK_URL = `http://127.0.0.1:${emailPort}/email`; // security-scan:allow private-url-literal (local loopback connector)
    const igCreated = await enqueue({ goal: 'INTEGRATE: read app.js and email the summary', approvedTools: ['email.send'] });
    step('enqueue integrations run', { status: igCreated.status, runId: igCreated.body.runId });
    if (igCreated.status !== 202) throw new Error(`POST /runs (integrations) failed: ${JSON.stringify(igCreated.body)}`);
    const igFinished = await waitTerminal(token, igCreated.body.runId);
    const igToolEvents = (igFinished.events ?? [])
      .filter((event) => event.type === 'tool_completed')
      .map((event) => { try { return JSON.parse(event.payload_json); } catch { return {}; } });
    const emailToolEvent = igToolEvents.find((event) => event.toolId === 'email.send');
    const toolsStatus = await request('/tools/status', { token });
    const integrationsResult = {
      status: igFinished.status,
      final: igFinished.result?.final ?? null,
      deliveredCount: emailReceived.length,
      deliveredTo: emailReceived.map((payload) => payload.to),
      emailToolOk: emailToolEvent?.ok === true,
      emailMessageId: emailToolEvent?.output?.messageId ?? null,
      connectorLive: (toolsStatus.body.live ?? []).includes('email.send'),
      evidenceCount: (igFinished.evidence ?? []).length,
    };
    step('integrations finished', integrationsResult);
    const igReport = await runBenchmark(integrationsBenchmark(), async () => integrationsResult);
    step('integrations benchmark', { summary: igReport.summary });

    report.finishedAt = new Date().toISOString();
    report.agentLoop = loopReport;
    report.multiAgent = maReport;
    report.longRunning = lrReport;
    report.codeIntelligence = ciReport;
    report.selfHealing = shReport;
    report.integrations = igReport;
    report.passed = loopReport.summary.passRate === 100
      && maReport.summary.passRate === 100
      && lrReport.summary.passRate === 100
      && ciReport.summary.passRate === 100
      && shReport.summary.passRate === 100
      && igReport.summary.passRate === 100;

    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nReport written to ${outFile}\n`);
    process.stdout.write(`RESULT: agent-loop=${loopReport.summary.passRate}% multi-agent=${maReport.summary.passRate}% long-running=${lrReport.summary.passRate}% code-intelligence=${ciReport.summary.passRate}% self-healing=${shReport.summary.passRate}% integrations=${igReport.summary.passRate}% passed=${report.passed}\n`);
    exitCode = report.passed ? 0 : 1;
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    if (emailServer) await new Promise((resolve) => emailServer.close(resolve));
    delete process.env.EMAIL_PROVIDER;
    delete process.env.EMAIL_WEBHOOK_URL;
    db.close();
    if (!keep) {
      await rm(dir, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    } else {
      process.stdout.write(`\nKept workspace: ${workspace}\nKept db dir: ${dir}\n`);
    }
  }
  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`agent-benchmark failed: ${error?.stack || error}\n`);
  process.exit(1);
});
