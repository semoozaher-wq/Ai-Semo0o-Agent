import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Production Trial — full End-to-End against the REAL backend process.
//
// Unlike the in-process HTTP tests, this boots `backend/server.mjs` as a real
// child process with a PRODUCTION configuration (NODE_ENV=production, a 32-byte
// SECRETS_MASTER_KEY, absolute DATABASE_FILE / WORKSPACE_ROOT, a real
// ALLOWED_ORIGIN) so the production env validation and the in-process worker are
// exercised exactly as they run on a host. The LLM is a local, OpenAI-compatible
// mock (OPENAI_API_BASE) so no external credentials are needed.
//
// The trial drives: register -> login -> project -> run -> approval -> worker ->
// SSE -> verify -> delivery, and asserts the run completed with a real delivery
// artifact on the isolated task branch and an untouched default branch.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PASSWORD = 'correct horse battery staple';

const VERIFY_EXPECTS_THREE = {
  command: 'node',
  args: ['-e', "const fs=require('fs');if(fs.readFileSync('app.js','utf8').trim()!=='module.exports = 3;')process.exit(1)"],
};
const BUGGY_APPLY_ARGS = {
  operations: [{ type: 'write', path: 'app.js', content: 'module.exports = 2;\n' }],
  verification: [VERIFY_EXPECTS_THREE],
  maxAttempts: 3,
};
const CORRECTED_APPLY = {
  operations: [{ type: 'write', path: 'app.js', content: 'module.exports = 3;\n' }],
  verification: [VERIFY_EXPECTS_THREE],
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeSourceRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-prod-src-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'src@example.invalid']);
  git(root, ['config', 'user.name', 'Source']);
  await writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

// A scripted, OpenAI-compatible /chat/completions endpoint. It answers the exact
// system prompts the agent runtime uses, so the real provider code path runs.
function startMockLLM() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      const system = (payload.messages || []).find((message) => message.role === 'system')?.content ?? '';
      let message;
      if (system.includes('secure planner')) {
        message = { role: 'assistant', content: JSON.stringify({ reasoning: 'edit and verify', steps: [{ id: 'step_1', title: 'Apply edit', toolId: 'workspace.apply', args: BUGGY_APPLY_ARGS }] }) };
      } else if (system.includes('Execute one planned step')) {
        message = { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'workspace__apply', arguments: JSON.stringify(BUGGY_APPLY_ARGS) } }] };
      } else if (system.includes('diagnosing a failed edit')) {
        message = { role: 'assistant', content: JSON.stringify(CORRECTED_APPLY) };
      } else if (system.includes('final answer')) {
        message = { role: 'assistant', content: 'تم إصلاح الخطأ والتحقق بنجاح، وتم تسليم العمل على فرع المهمة.' };
      } else {
        message = { role: 'assistant', content: JSON.stringify({ action: 'retry', args: BUGGY_APPLY_ARGS }) };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chatcmpl-prod-trial',
        object: 'chat.completion',
        model: payload.model || 'gpt-5-mini',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      }));
    });
  });
  return server;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`WAIT_TIMEOUT:${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function makeRequest(base) {
  return async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
}

// Read an SSE run stream until it closes, returning the parsed event payloads.
async function readSSE(url, token, { timeoutMs = 20_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        try { events.push(JSON.parse(dataLine.slice(6))); } catch { /* ignore keep-alives */ }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

test('production trial: real backend boots in production config and runs Goal->Plan->Execute->Test->Repair->Verify->Delivery', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-prod-trial-'));
  const source = await makeSourceRepo();
  const mock = startMockLLM();
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = mock.address().port;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const logs = [];
  const child = spawn(process.execPath, ['--experimental-sqlite', 'backend/server.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      DATABASE_FILE: path.join(dir, 'db', 'agent.sqlite'),
      WORKSPACE_ROOT: path.join(dir, 'workspace'),
      ALLOWED_ORIGIN: 'https://app.semo0o.example',
      BIND_HOST: '127.0.0.1',
      PORT: String(port),
      OPENAI_API_KEY: 'sk-prod-trial-key',
      OPENAI_API_BASE: `http://127.0.0.1:${mockPort}/v1`,
      OPENAI_MODEL: 'gpt-5-mini',
      RATE_LIMIT_MAX: '1000',
      WORKER_POLL_MS: '20',
      LOG_FORMAT: 'json',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  const request = makeRequest(base);
  try {
    // --- boot: production env validation passes and /health is reachable ----
    await waitFor(async () => {
      try { const health = await request('/health'); return health.status === 200 && health.body.ok === true; }
      catch { return false; }
    }, { timeoutMs: 30_000, label: 'health' });
    const health = await request('/health');
    assert.equal(health.body.service, 'ai-semo0o-agent-backend');

    // --- register -> login (real HTTP, no direct DB access) ----------------
    const registered = await request('/auth/register', { method: 'POST', body: { email: 'prod-trial@e2e.test', password: PASSWORD, tenantName: 'Prod Trial' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    // No external email provider is configured, so the API must never claim an
    // email was sent: it only *queues* into the local outbox and says so.
    assert.equal(registered.body.verificationRequired, true);
    assert.equal(registered.body.delivery, 'queued');
    assert.ok(typeof registered.body.outboxId === 'string' && registered.body.outboxId.length > 0, 'queued delivery must carry a real outbox id');
    const login = await request('/auth/login', { method: 'POST', body: { email: 'prod-trial@e2e.test', password: PASSWORD } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = login.body.session.token;

    // --- integrations are fail-closed with no connector credentials --------
    const integrations = await request('/integrations/status', { token });
    assert.equal(integrations.status, 200, JSON.stringify(integrations.body));
    const unwired = integrations.body.tools?.unwired ?? [];
    assert.ok(Array.isArray(unwired), 'unconfigured connectors must be reported unwired');
    // Connectors that need *dedicated* credentials (absent here) must be fail-closed.
    assert.ok(unwired.includes('calendar.schedule'), 'calendar.schedule must be unwired without CALENDAR_* credentials');
    assert.ok(unwired.includes('email.send'), 'email.send must be unwired without EMAIL_* credentials');
    assert.ok(unwired.includes('browser.run'), 'browser.run must be unwired without a browser/CDP config');
    // The image/vision connectors intentionally share OPENAI_API_KEY, so with a
    // key present they are honestly *live* (a real provider config exists) — not
    // a fake success, and not silently hidden.
    assert.ok(integrations.body.tools?.live?.includes('image.generate'), 'image.generate is live because OPENAI_API_KEY is configured');

    // --- project + run -----------------------------------------------------
    const project = await request('/projects', { method: 'POST', token, body: { name: 'Prod', rootPath: path.join(dir, 'workspace', 'project-root') } });
    assert.equal(project.status, 201, JSON.stringify(project.body));

    const created = await request('/runs', {
      method: 'POST',
      token,
      // requiresApproval holds the run until the isolated workspace exists, so the
      // engine resolves against the real task checkout (no race).
      body: { kind: 'agent.run', goal: 'اجعل الاختبار يمر ثم سلّم العمل', projectId: project.body.projectId, workspaceId: project.body.workspaceId, model: 'test', requiresApproval: true },
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const { runId, taskId } = created.body;

    // --- isolated task workspace (real git clone on a task branch) ---------
    const provisioned = await request(`/tasks/${taskId}/workspace`, { method: 'POST', token, body: { repo: source } });
    assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
    const taskWorkspace = provisioned.body.workspacePath;
    const mainTip = git(taskWorkspace, ['rev-parse', 'main']);

    // --- open the SSE stream, then approve the run so it starts ------------
    const ssePromise = readSSE(`${base}/runs/${runId}/events`, token, { timeoutMs: 25_000 });
    const approved = await request(`/runs/${runId}/approval`, { method: 'POST', token, body: { decision: 'allow' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    // --- the dangerous workspace.apply pauses for a second approval --------
    const waiting = await waitFor(async () => {
      const run = await request(`/runs/${runId}`, { token });
      return run.body.status === 'waiting_approval' ? run.body : null;
    }, { label: 'tool-approval' });
    assert.ok(waiting, 'the dangerous apply must pause for human approval');
    const approved2 = await request(`/runs/${runId}/approval`, { method: 'POST', token, body: { decision: 'allow' } });
    assert.equal(approved2.status, 200, JSON.stringify(approved2.body));

    // --- Execute -> Test (fails) -> Repair -> Verify -> Delivery -----------
    const finished = await waitFor(async () => {
      const run = await request(`/runs/${runId}`, { token });
      return ['completed', 'failed', 'unverified', 'blocked', 'cancelled'].includes(run.body.status) ? run.body : null;
    }, { label: 'completion' });
    assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 1500));

    // Repair really happened (attempts:2, state verified).
    const applyEvidence = finished.evidence.find((item) => item.kind === 'tool.result' && item.payload_json.includes('workspace.apply'));
    assert.ok(applyEvidence, 'workspace.apply evidence must be recorded');
    assert.ok(applyEvidence.payload_json.includes('"state":"verified"'), 'the final apply must be verified');
    assert.ok(/"attempts":2/.test(applyEvidence.payload_json), 'the engine must have repaired on the 2nd attempt');

    // Delivery artifact.
    const delivery = finished.result?.delivery;
    assert.ok(delivery, 'the run result must include the delivery artifact');
    assert.equal(delivery.delivered, true, JSON.stringify(delivery));
    assert.equal(delivery.branch, `semo0o/task/${taskId}`);
    assert.ok(delivery.revision, 'delivery must report the commit revision');

    // The corrected edit landed in the task checkout and was delivered...
    assert.equal(await readFile(path.join(taskWorkspace, 'app.js'), 'utf8'), 'module.exports = 3;\n');
    assert.equal(git(taskWorkspace, ['rev-parse', 'HEAD']), delivery.revision);
    assert.match(git(taskWorkspace, ['log', '-1', '--pretty=%s']), /^semo0o: deliver/);
    // ...and the protected default branch is untouched.
    assert.equal(git(taskWorkspace, ['rev-parse', 'main']), mainTip);
    assert.equal(git(taskWorkspace, ['branch', '--show-current']), `semo0o/task/${taskId}`);

    // The SSE stream carried the whole lifecycle in order.
    const events = await ssePromise;
    const types = events.map((event) => event.type);
    assert.ok(types.includes('planning_completed'), `SSE must include Plan: ${types.join(',')}`);
    assert.ok(types.includes('permission_requested'), 'SSE must include the approval gate');
    assert.ok(types.includes('step_completed'), 'SSE must include Verify');
    assert.ok(types.includes('delivery_completed'), 'SSE must include Delivery');
    assert.ok(types.includes('run_finished'), 'SSE must include run_finished');

    // --- production secrets never leak into the API surface ----------------
    const serialized = JSON.stringify(finished);
    assert.ok(!serialized.includes('sk-prod-trial-key'), 'the provider key must never appear in a run response');
    assert.ok(!serialized.includes(Buffer.alloc(32, 7).toString('base64')), 'the master key must never appear in a run response');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => mock.close(resolve));
    await rm(dir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
    if (process.env.PROD_TRIAL_DEBUG === '1') console.error(logs.join(''));
  }
});
