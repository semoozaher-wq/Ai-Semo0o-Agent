// Production E2E harness — boots the REAL backend process (node --experimental-sqlite
// backend/server.mjs) with a production env contract and a mock OpenAI-compatible
// provider, then drives the whole path over HTTP:
//   /health -> /ready -> /metrics -> register -> login -> project -> agent.run
//   -> queue/worker -> planning -> tool -> evidence -> verification -> completion
//   -> evaluation -> tools/status -> models/status
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REPO = '/workspace/Ai-Semo0o-Agent';
let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
  results.push({ name, ok: !!cond, detail });
}

function startMockOpenAI() {
  const state = { calls: 0, models: [] };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', (c) => { raw += c; });
    request.on('end', () => {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      state.calls += 1; state.models.push(body.model);
      const reply = (p) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(p)); };
      const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
      if (state.calls === 1) return reply({ choices: [{ message: { content: JSON.stringify({ reasoning: 'scan the workspace', steps: [{ id: 'step_1', title: 'Scan workspace', toolId: 'files.scan', args: { scope: '.', maxFiles: 20 } }] }) } }], usage });
      if (state.calls === 2) return reply({ choices: [{ message: { content: '' } }], usage });
      return reply({ choices: [{ message: { content: 'تم فحص مساحة العمل فعليًا مع دليل من أداة الملفات.' } }], usage });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` })));
}

async function waitFor(url, { tries = 60, ms = 300 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return r; } catch {}
    await new Promise((r) => setTimeout(r, ms));
  }
  return null;
}

const mock = await startMockOpenAI();
const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-prod-e2e-'));
const dbDir = path.join(dir, 'db');
const wsRoot = path.join(dir, 'workspace');
await mkdir(dbDir, { recursive: true, mode: 0o700 });
await mkdir(wsRoot, { recursive: true, mode: 0o700 });
await writeFile(path.join(wsRoot, 'input.txt'), 'real production workspace evidence');

const PORT = 8901;
const env = {
  ...process.env,
  NODE_ENV: 'production',
  SECRETS_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  DATABASE_FILE: path.join(dbDir, 'agent.sqlite'),
  WORKSPACE_ROOT: wsRoot,
  ALLOWED_ORIGIN: 'https://app.example.test',
  OPENAI_API_KEY: 'sk-prod-e2e',
  OPENAI_API_BASE: mock.baseUrl,
  DISABLE_WORKER: '0',
  PORT: String(PORT),
  BIND_HOST: '127.0.0.1',
  LOG_FORMAT: 'json',
  METRICS_TOKEN: 'prod-e2e-metrics-token',
};

const child = spawn(process.execPath, ['--experimental-sqlite', 'backend/server.mjs'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const base = `http://127.0.0.1:${PORT}`;
const req = async (route, { method = 'GET', token, body, headers = {} } = {}) => {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, text };
};

try {
  console.log('\n[1] Boot the real production server process');
  const health = await waitFor(`${base}/health`);
  check('server process boots and answers /health', !!health, serverLog.slice(-400));
  const hb = health ? await health.json() : {};
  check('/health ok=true + version', hb.ok === true && !!hb.version, JSON.stringify(hb));

  console.log('\n[2] Readiness + metrics');
  const ready = await req('/ready');
  check('/ready is 200 with a configured provider', ready.status === 200, `status=${ready.status} body=${JSON.stringify(ready.body).slice(0, 200)}`);
  check('/ready checks.database.ok', ready.body?.checks?.database?.ok === true, JSON.stringify(ready.body?.checks));
  const metrics = await req('/metrics');
  check('/metrics returns Prometheus text', metrics.status === 200 && /# (HELP|TYPE)/.test(metrics.text), `status=${metrics.status}`);

  console.log('\n[3] Auth: register -> login -> session');
  const reg = await req('/auth/register', { method: 'POST', body: { email: 'prod-e2e@example.test', password: 'correct horse battery staple', tenantName: 'Prod E2E' } });
  check('register 201 + session token', reg.status === 201 && !!reg.body?.session?.token, `status=${reg.status}`);
  const token = reg.body?.session?.token;
  const login = await req('/auth/login', { method: 'POST', body: { email: 'prod-e2e@example.test', password: 'correct horse battery staple' } });
  check('login 200 + session token', login.status === 200 && !!login.body?.session?.token, `status=${login.status}`);
  const unauth = await req('/tools/status');
  check('unauthenticated /tools/status is rejected (401)', unauth.status === 401, `status=${unauth.status}`);

  console.log('\n[4] Project + workspace');
  const project = await req('/projects', { method: 'POST', token, body: { name: 'Prod E2E', rootPath: wsRoot } });
  check('project created (201)', project.status === 201 && !!project.body?.projectId && !!project.body?.workspaceId, `status=${project.status} body=${JSON.stringify(project.body)}`);

  console.log('\n[5] agent.run -> queue -> worker -> completion');
  const created = await req('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'افحص مساحة العمل وأعطني النتيجة', model: 'gpt-5' } });
  check('run accepted (202)', created.status === 202 && !!created.body?.runId, `status=${created.status} body=${JSON.stringify(created.body)}`);
  const runId = created.body?.runId;

  let run = null;
  for (let i = 0; i < 100; i++) {
    const r = await req(`/runs/${runId}`, { token });
    run = r.body;
    if (run && ['completed', 'failed', 'blocked', 'canceled'].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check('run reaches terminal state', !!run && ['completed', 'failed'].includes(run.status), `status=${run?.status}`);
  check('run completed (not failed)', run?.status === 'completed', `status=${run?.status} result=${JSON.stringify(run?.result)?.slice(0, 200)}`);
  check('evidence includes tool.result', Array.isArray(run?.evidence) && run.evidence.some((e) => e.kind === 'tool.result'), `evidence=${JSON.stringify(run?.evidence?.map((e) => e.kind))}`);
  check('evidence includes verification', Array.isArray(run?.evidence) && run.evidence.some((e) => e.kind === 'verification'), `evidence=${JSON.stringify(run?.evidence?.map((e) => e.kind))}`);
  check('run_events recorded (planning/tool/step/finish)', Array.isArray(run?.events) && run.events.length >= 4, `events=${run?.events?.length}`);
  check('usage recorded (tokens)', Array.isArray(run?.usage) && run.usage.length >= 1 && run.usage[0].total_tokens > 0, `usage=${JSON.stringify(run?.usage)}`);
  check('all LLM calls hit the configured provider model', mock.state.models.length >= 3 && mock.state.models.every((m) => m === 'gpt-5'), `models=${mock.state.models.join(',')}`);

  console.log('\n[6] Evaluation + tool/model status');
  const evaluation = await req(`/runs/${runId}/evaluation`, { token });
  check('evaluation endpoint returns a scorecard', evaluation.status === 200 && (evaluation.body?.evaluated === true || evaluation.body?.composite != null || evaluation.body?.outcome != null), `status=${evaluation.status} body=${JSON.stringify(evaluation.body).slice(0, 200)}`);
  const toolsStatus = await req('/tools/status', { token });
  check('/tools/status authenticated 200 with summary', toolsStatus.status === 200 && !!toolsStatus.body?.summary, `status=${toolsStatus.status}`);
  check('files.scan is live', Array.isArray(toolsStatus.body?.live) && toolsStatus.body.live.includes('files.scan'), `live=${JSON.stringify(toolsStatus.body?.live)}`);
  const modelsStatus = await req('/models/status', { token });
  check('/models/status shows the configured provider', modelsStatus.status === 200 && Array.isArray(modelsStatus.body?.providers) && modelsStatus.body.providers.some((p) => p.id === 'openai' && p.configured), `status=${modelsStatus.status} body=${JSON.stringify(modelsStatus.body).slice(0, 200)}`);

  console.log('\n[7] Idempotency + concurrency guard');
  const idem = await req('/runs', { method: 'POST', token, headers: { 'idempotency-key': 'prod-e2e-idem-1' }, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'idempotent goal' } });
  const idem2 = await req('/runs', { method: 'POST', token, headers: { 'idempotency-key': 'prod-e2e-idem-1' }, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'idempotent goal' } });
  check('same idempotency key returns the same run', idem.body?.runId === idem2.body?.runId && idem2.body?.idempotent === true, `a=${idem.body?.runId} b=${idem2.body?.runId}`);

  console.log(`\n==== PROD E2E: ${pass} passed, ${fail} failed ====`);
} catch (error) {
  fail++;
  console.log('HARNESS ERROR:', error?.stack || error);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (!child.killed) child.kill('SIGKILL');
  await new Promise((r) => mock.server.close(r));
  await rm(dir, { recursive: true, force: true });
}

console.log('\n--- server log tail ---');
console.log(serverLog.split('\n').slice(-25).join('\n'));
process.exit(fail === 0 ? 0 : 1);
