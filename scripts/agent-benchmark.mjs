#!/usr/bin/env node
/**
 * scripts/agent-benchmark.mjs — Agent Evaluation & Benchmark Engine (real).
 *
 * Runs the REAL agent stack end-to-end (HTTP API -> RunQueue -> agent runtime
 * with a deterministic offline planner) over a throwaway workspace, then scores
 * the outcome with the SAME engine the rest of the platform uses
 * (phase2-core/eval.mjs). It also runs the code-intelligence agent benchmark
 * (backend/ops/capability-benchmark.mjs) against the real project index.
 *
 * Nothing is mocked except the LLM: the planner is deterministic so the
 * benchmark is reproducible without network or API keys, while still exercising
 * the real planner -> tool -> verification -> final-synthesis path.
 *
 * Usage:
 *   node --experimental-sqlite scripts/agent-benchmark.mjs [--out report.json] [--keep]
 * Exit code is non-zero when the benchmark does not pass.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

// A deterministic, offline planner. It answers the three prompts the runtime
// uses (plan / execute-step / final) so the real loop runs without a network.
function deterministicLLM() {
  return {
    status: () => [{ id: 'benchmark', configured: true }],
    async complete({ messages = [] } = {}) {
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      if (system.includes('secure planner')) {
        return {
          provider: 'benchmark',
          text: JSON.stringify({
            reasoning: 'Scan the workspace and analyze a source file to gather evidence.',
            steps: [
              { id: 'step_1', title: 'Scan workspace', toolId: 'files.scan', args: { scope: '.', maxFiles: 50 } },
              { id: 'step_2', title: 'Analyze app.js', toolId: 'code.analyze', args: { path: 'app.js' } },
            ],
          }),
          toolCalls: [],
          usage: { promptTokens: 12, completionTokens: 24, totalTokens: 36 },
        };
      }
      if (system.includes('Execute one planned step')) {
        return { provider: 'benchmark', text: '', toolCalls: [], usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } };
      }
      return { provider: 'benchmark', text: 'تم فحص مساحة العمل وتحليل الملف بنجاح مع دليل من الأدوات.', toolCalls: [], usage: { promptTokens: 10, completionTokens: 8, totalTokens: 18 } };
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

// Score the real agent-loop outcome with the shared eval engine.
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

  const report = { startedAt: new Date().toISOString(), workspace, steps: [] };
  const step = (name, data) => {
    report.steps.push({ name, ...data });
    process.stdout.write(`\n== ${name} ==\n${JSON.stringify(data, null, 2)}\n`);
  };

  let exitCode = 0;
  try {
    const registered = await request('/auth/register', { method: 'POST', body: { email: 'bench@agent.test', password: PASSWORD, tenantName: 'Benchmark' } });
    const token = registered.body.session.token;
    const project = await request('/projects', { method: 'POST', token, body: { name: 'Benchmark project', rootPath: workspace } });
    step('setup', { register: registered.status, project: project.status, projectId: project.body.projectId });

    const created = await request('/runs', {
      method: 'POST',
      token,
      body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'افحص مساحة العمل وحلّل ملف app.js', model: 'test' },
    });
    step('enqueue agent.run', { status: created.status, runId: created.body.runId, taskId: created.body.taskId });
    if (created.status !== 202) throw new Error(`POST /runs failed: ${JSON.stringify(created.body)}`);

    queue.start();
    const finished = await waitFor(async () => {
      const run = await request(`/runs/${created.body.runId}`, { token });
      return ['completed', 'failed', 'unverified', 'blocked', 'completed_with_warnings'].includes(run.body.status) ? run.body : null;
    });

    const loopResult = {
      status: finished.status,
      final: finished.result?.final ?? null,
      evidenceCount: (finished.evidence ?? []).length,
      toolResultEvents: (finished.events ?? []).filter((event) => event.type === 'tool_completed').length,
    };
    step('agent loop finished', loopResult);

    const loopReport = await runBenchmark(agentLoopBenchmark(), async () => loopResult);
    step('agent-loop benchmark', { summary: loopReport.summary });

    // Code-intelligence agent benchmark over the SAME real workspace.
    const intelligence = await buildProjectIntelligence(workspace);
    const { report: ciReport, workspace: ciWorkspace } = await runAgentBenchmark({ tools, root: workspace, intelligence });
    step('code-intelligence benchmark', { workspace: ciWorkspace, summary: ciReport.summary, tasks: ciReport.tasks.map((task) => ({ id: task.id, ok: task.ok, score: task.score })) });

    report.finishedAt = new Date().toISOString();
    report.agentLoop = loopReport;
    report.codeIntelligence = ciReport;
    report.passed = loopReport.summary.passRate === 100 && ciReport.summary.passRate === 100;

    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nReport written to ${outFile}\n`);
    process.stdout.write(`RESULT: agent-loop=${loopReport.summary.passRate}% code-intelligence=${ciReport.summary.passRate}% passed=${report.passed}\n`);
    exitCode = report.passed ? 0 : 1;
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
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
