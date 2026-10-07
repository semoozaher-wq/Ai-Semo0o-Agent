#!/usr/bin/env node
/**
 * phase2-task-demo.mjs
 * ---------------------------------------------------------------------------
 * Runs a REAL task end-to-end through the EXISTING stack and prints the
 * evidence. Nothing here is a mock of the pipeline: the HTTP API, the queue,
 * the per-task workspace provisioning, the AgentExecutionEngine and its
 * Edit -> Test -> Diagnose/Fix -> Retest loop, the permission/approval gate and
 * the evidence store are all the production components.
 *
 *   Task -> Orchestrator (HTTP) -> Isolated task workspace -> Agent + engine
 *        -> Edit -> Test -> (Diagnose/Fix) -> Retest -> Evidence
 *        -> Human approval -> (NO push / NO merge / master untouched)
 *
 * The only thing replaced is the LLM: a deterministic, offline planner is used
 * so the run is reproducible without network or API keys. The planner still
 * goes through the real planner -> tool -> approval -> verification -> final
 * synthesis path in backend/agent/runtime.mjs.
 *
 * Usage:
 *   node --experimental-sqlite scripts/phase2-task-demo.mjs [--out report.json] [--keep]
 * ---------------------------------------------------------------------------
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Database } from '../backend/db/client.mjs';
import { createApp } from '../backend/server.mjs';
import { RunQueue } from '../backend/queue/queue.mjs';
import { createUser } from '../backend/auth/security.mjs';

const PASSWORD = 'correct horse battery staple';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const keep = process.argv.includes('--keep');
const outFile = arg('--out', path.join(REPO_ROOT, 'phase2-task-demo.report.json'));

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeSourceRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-demo-src-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'src@example.invalid']);
  git(root, ['config', 'user.name', 'Source']);
  await writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

// The task: change app.js so its exported value is 2, and prove it with a test.
const APPLY_ARGS = {
  operations: [{ type: 'write', path: 'app.js', content: 'module.exports = 2;\n' }],
  verification: [
    {
      command: 'node',
      args: ['-e', "const fs=require('fs');if(fs.readFileSync('app.js','utf8').trim()!=='module.exports = 2;')process.exit(1)"],
    },
  ],
  maxAttempts: 2,
};

function demoLLM() {
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete({ messages = [] } = {}) {
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      if (system.includes('secure planner')) {
        return {
          provider: 'demo',
          text: JSON.stringify({
            reasoning: 'edit app.js and verify the exported value',
            steps: [{ id: 'step_1', title: 'Apply edit and verify', toolId: 'workspace.apply', args: APPLY_ARGS }],
          }),
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        };
      }
      if (system.includes('Execute one planned step')) {
        return {
          provider: 'demo',
          text: '',
          toolCalls: [{ name: 'workspace__apply', arguments: APPLY_ARGS }],
          usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        };
      }
      if (system.includes('final answer')) {
        return { provider: 'demo', text: 'تم التعديل والتحقق بنجاح.', toolCalls: [], usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 } };
      }
      return { provider: 'demo', text: JSON.stringify({ action: 'retry', args: APPLY_ARGS }), toolCalls: [], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
    },
  };
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

async function main() {
  const source = await makeSourceRepo();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-demo-'));
  const db = new Database(path.join(dir, 'demo.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm: demoLLM() });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`; // security-scan:allow private-url-literal (local loopback bind, not a hardcoded host)
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const report = { startedAt: new Date().toISOString(), steps: [] };
  const step = (name, data) => {
    report.steps.push({ name, ...data });
    process.stdout.write(`\n== ${name} ==\n${JSON.stringify(data, null, 2)}\n`);
  };

  try {
    createUser(db, { email: 'demo@phase2.test', password: PASSWORD, tenantName: 'Demo' });
    const login = await request('/auth/login', { method: 'POST', body: { email: 'demo@phase2.test', password: PASSWORD } });
    const token = login.body.session.token;
    step('login', { status: login.status, tenantId: login.body.session?.tenantId });

    const projectRoot = path.join(dir, 'project-root');
    const project = await request('/projects', { method: 'POST', token, body: { name: 'Demo project', rootPath: projectRoot } });
    step('create project', { status: project.status, projectId: project.body.projectId, workspaceId: project.body.workspaceId });

    const created = await request('/runs', {
      method: 'POST',
      token,
      body: { kind: 'agent.run', goal: 'اجعل الاختبار يمر', projectId: project.body.projectId, workspaceId: project.body.workspaceId, model: 'test' },
    });
    const { runId, taskId } = created.body;
    step('enqueue agent.run', { status: created.status, runId, taskId, body: created.body });
    if (created.status !== 202) throw new Error(`POST /runs failed: ${JSON.stringify(created.body)}`);

    const provisioned = await request(`/tasks/${taskId}/workspace`, { method: 'POST', token, body: { repo: source } });
    const taskWorkspace = provisioned.body.workspacePath;
    const evidenceDirectory = provisioned.body.evidenceDirectory;
    const mainTipBefore = git(taskWorkspace, ['rev-parse', 'main']);
    step('provision isolated task workspace', {
      status: provisioned.status,
      workspacePath: taskWorkspace,
      evidenceDirectory,
      branch: provisioned.body.branch,
      branchCreated: provisioned.body.branchCreated,
      mainTipBefore,
    });

    queue.start();

    const waiting = await waitFor(async () => {
      const run = await request(`/runs/${runId}`, { token });
      return run.body.status === 'waiting_approval' ? run.body : null;
    });
    step('run paused for human approval (dangerous tool)', { status: waiting.status, pendingApproval: waiting.pendingApproval ?? null });

    const approved = await request(`/runs/${runId}/approval`, { method: 'POST', token, body: { decision: 'allow' } });
    step('human approval', { status: approved.status, decision: 'allow' });

    const finished = await waitFor(async () => {
      const run = await request(`/runs/${runId}`, { token });
      return ['completed', 'failed', 'unverified', 'blocked'].includes(run.body.status) ? run.body : null;
    });

    const editedContent = await readFile(path.join(taskWorkspace, 'app.js'), 'utf8');
    const mainTipAfter = git(taskWorkspace, ['rev-parse', 'main']);
    const currentBranch = git(taskWorkspace, ['branch', '--show-current']);
    const gitStatus = git(taskWorkspace, ['status', '--porcelain']);
    const gitDiff = git(taskWorkspace, ['diff', 'main', '--', 'app.js']);
    const branches = git(taskWorkspace, ['branch', '--list']);

    step('run finished', {
      status: finished.status,
      attempts: finished.attempts ?? null,
      editedAppJs: editedContent,
      currentBranch,
      mainTipBefore,
      mainTipAfter,
      defaultBranchUntouched: mainTipBefore === mainTipAfter,
      branches: branches.split('\n').map((line) => line.trim()),
      gitStatusPorcelain: gitStatus || '(clean)',
      gitDiffVsMain: gitDiff,
    });

    step('evidence + events (permissions / approval / tool result)', {
      evidenceCount: (finished.evidence ?? []).length,
      evidenceKinds: [...new Set((finished.evidence ?? []).map((item) => item.kind))],
      eventTypes: [...new Set((finished.events ?? []).map((event) => event.type))],
      toolResultMentionsWorkspaceApply: (finished.evidence ?? []).some(
        (item) => item.kind === 'tool.result' && String(item.payload_json).includes('workspace.apply'),
      ),
    });

    report.finishedAt = new Date().toISOString();
    report.result = {
      runStatus: finished.status,
      taskId,
      workspacePath: taskWorkspace,
      evidenceDirectory,
      branch: currentBranch,
      defaultBranchUntouched: mainTipBefore === mainTipAfter,
      editedAppJs: editedContent,
    };

    await fsp.writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\nReport written to ${outFile}\n`);
    process.stdout.write(`RESULT: ${finished.status} | branch=${currentBranch} | main untouched=${mainTipBefore === mainTipAfter}\n`);
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    if (!keep) {
      await rm(dir, { recursive: true, force: true });
      await rm(source, { recursive: true, force: true });
    } else {
      process.stdout.write(`\nKept demo dir: ${dir}\nKept source repo: ${source}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`phase2-task-demo failed: ${error?.stack || error}\n`);
  process.exit(1);
});
