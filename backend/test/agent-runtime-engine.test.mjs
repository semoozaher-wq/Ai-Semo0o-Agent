import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';

const PASSWORD = 'correct horse battery staple';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeSourceRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-engine-src-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'src@example.invalid']);
  git(root, ['config', 'user.name', 'Source']);
  await writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

const APPLY_ARGS = {
  operations: [{ type: 'write', path: 'app.js', content: 'module.exports = 2;\n' }],
  // NOTE: read the file via fs (bare specifier) instead of a relative require of
  // app.js, so the static import verifier does not treat this eval string as an import.
  verification: [{ command: 'node', args: ['-e', "const fs=require('fs');if(fs.readFileSync('app.js','utf8').trim()!=='module.exports = 2;')process.exit(1)"] }],
  maxAttempts: 2,
};

// A fake LLM that plans a single dangerous `workspace.apply` step, then executes
// it through a real tool call, then synthesizes a final answer.
function engineLLM() {
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete({ messages = [] } = {}) {
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      if (system.includes('secure planner')) {
        return {
          provider: 'test',
          text: JSON.stringify({ reasoning: 'edit and verify', steps: [{ id: 'step_1', title: 'Apply edit', toolId: 'workspace.apply', args: APPLY_ARGS }] }),
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        };
      }
      if (system.includes('Execute one planned step')) {
        return { provider: 'test', text: '', toolCalls: [{ name: 'workspace__apply', arguments: APPLY_ARGS }], usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      }
      if (system.includes('final answer')) {
        return { provider: 'test', text: 'تم التعديل والتحقق بنجاح.', toolCalls: [], usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 } };
      }
      return { provider: 'test', text: JSON.stringify({ action: 'retry', args: APPLY_ARGS }), toolCalls: [], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
    },
  };
}

async function waitFor(check, { timeoutMs = 25_000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('the agent edits and tests inside its isolated task workspace through the engine', async () => {
  const source = await makeSourceRepo();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-engine-e2e-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm: engineLLM() });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  try {
    createUser(db, { email: 'engine@e2e.test', password: PASSWORD, tenantName: 'Engine' });
    const login = await request('/auth/login', { method: 'POST', body: { email: 'engine@e2e.test', password: PASSWORD } });
    const token = login.body.session.token;

    const projectRoot = path.join(dir, 'project-root');
    const project = await request('/projects', { method: 'POST', token, body: { name: 'P', rootPath: projectRoot } });
    assert.equal(project.status, 201, JSON.stringify(project.body));

    // Create the agent run first, then provision its isolated task workspace.
    const created = await request('/runs', {
      method: 'POST',
      token,
      body: { kind: 'agent.run', goal: 'اجعل الاختبار يمر', projectId: project.body.projectId, workspaceId: project.body.workspaceId, model: 'test' },
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const { runId, taskId } = created.body;

    const provisioned = await request(`/tasks/${taskId}/workspace`, { method: 'POST', token, body: { repo: source } });
    assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
    const taskWorkspace = provisioned.body.workspacePath;
    const mainTip = git(taskWorkspace, ['rev-parse', 'main']);

    queue.start();

    // The dangerous workspace.apply tool must wait for human approval.
    const waiting = await waitFor(async () => {
      const run = await request(`/runs/${runId}`, { token });
      return run.body.status === 'waiting_approval' ? run.body : null;
    });
    assert.ok(waiting, 'run should pause for approval');

    const approved = await request(`/runs/${runId}/approval`, { method: 'POST', token, body: { decision: 'allow' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const finished = await waitFor(async () => {
      const run = await request(`/runs/${runId}`, { token });
      return ['completed', 'failed', 'unverified', 'blocked'].includes(run.body.status) ? run.body : null;
    });
    assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 1200));

    // The edit really landed inside the isolated task workspace...
    assert.equal(await readFile(path.join(taskWorkspace, 'app.js'), 'utf8'), 'module.exports = 2;\n');
    // ...and the protected default branch is untouched (no push/merge/commit).
    assert.equal(git(taskWorkspace, ['rev-parse', 'main']), mainTip);
    assert.equal(git(taskWorkspace, ['branch', '--show-current']), `semo0o/task/${taskId}`);
    // Evidence records the engine-backed tool result and the verification.
    assert.ok(finished.evidence.some((item) => item.kind === 'tool.result' && item.payload_json.includes('workspace.apply')));
    assert.ok(finished.events.some((event) => event.type === 'tool_completed'));
    assert.ok(finished.events.some((event) => event.type === 'permission_requested'));
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
