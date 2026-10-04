import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Database, id, now } from './db/client.mjs';
import { authenticate, authenticateToken, createSession, createUser, revokeSession, requireRole, passwordHash } from './auth/security.mjs';
import { acceptInvitation, consumeQuota, confirmMfa, createInvitation, enableMfa, issueAccountToken, resetPassword, verifyEmail } from './auth/lifecycle.mjs';
import { RunQueue } from './queue/queue.mjs';
import { createCodeRunHandler } from './runners/code-runner.mjs';
import { RateLimiter, applySecurityHeaders } from './security/http.mjs';
import { createLiveToolRegistry } from './tools/registry.mjs';
import { createLLMRouter } from './llm/providers.mjs';
import { createAgentRunHandler } from './agent/runtime.mjs';

const json = (value) => JSON.stringify(value);
function body(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      raw += chunk;
      if (raw.length > 2_000_000) {
        rejected = true;
        request.destroy();
        reject(new Error('BODY_TOO_LARGE'));
      }
    });
    request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('INVALID_JSON')); } });
    request.on('error', reject);
  });
}
function send(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(json(data));
}
function bearer(request) { const value = request.headers.authorization ?? ''; return value.startsWith('Bearer ') ? value.slice(7) : null; }
function requireUser(db, request) { const user = authenticateToken(db, bearer(request)); if (!user) throw new Error('UNAUTHORIZED'); return user; }
function routeParts(url) { return new URL(url, 'http://localhost').pathname.split('/').filter(Boolean); }
function validateText(value, name, max = 120) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`INVALID_${name.toUpperCase()}`);
  return value.trim();
}
function requiresApprovalFor(kind, input) {
  return kind === 'code.run' || kind === 'workspace.write' || kind === 'workspace.delete' || kind === 'email.send' || input.requiresApproval === true;
}
function assertProjectAccess(project, user) {
  if (!project || project.tenant_id !== user.tenantId) throw new Error('NOT_FOUND');
  if (!['owner', 'admin'].includes(user.role) && project.owner_id !== user.id) throw new Error('FORBIDDEN');
}
function assertRunAccess(db, run, user) {
  const task = db.get('SELECT created_by, project_id FROM tasks WHERE id=?', run.task_id);
  const project = task ? db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', task.project_id, user.tenantId) : null;
  assertProjectAccess(project, user);
  return task;
}

function resolveWorkspaceRoot(requested, projectId) {
  const configured = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : null;
  const candidate = requested ? path.resolve(requested) : configured ? path.join(configured, projectId) : null;
  if (!candidate) throw new Error('WORKSPACE_ROOT_REQUIRED');
  if (configured && candidate !== configured && !candidate.startsWith(`${configured}${path.sep}`)) throw new Error('WORKSPACE_PATH_OUTSIDE_ROOT');
  return candidate;
}

function modelCost(model, usage = {}) {
  const prices = { 'gpt-5-nano': [0.05, 0.40], 'gpt-5-mini': [0.25, 2.00], 'gpt-5': [1.25, 10.00], 'gpt-5.5': [5.00, 30.00], 'gemini-3-flash-preview': [0.50, 3.00], 'gemini-3.1-pro-preview': [2.00, 12.00], 'claude-haiku-4-5': [1.00, 5.00], 'claude-sonnet-4-6': [3.00, 15.00], 'claude-opus-4-7': [5.00, 25.00] };
  const [input, output] = prices[model] ?? [0, 0];
  return ((Number(usage.promptTokens) || 0) / 1_000_000) * input + ((Number(usage.completionTokens) || 0) / 1_000_000) * output;
}

async function streamRunEvents(response, db, runId, tenantId, request) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let cursor = 0;
  let closed = false;
  request.on('close', () => { closed = true; });
  while (!closed) {
    const events = db.all('SELECT rowid AS sequence, payload_json FROM run_events WHERE run_id=? AND tenant_id=? AND rowid>? ORDER BY rowid ASC', runId, tenantId, cursor);
    for (const item of events) { cursor = item.sequence; response.write(`id: ${item.sequence}\ndata: ${item.payload_json}\n\n`); }
    const run = db.get('SELECT status FROM runs WHERE id=? AND tenant_id=?', runId, tenantId);
    if (!run || ['completed','completed_with_warnings','failed','blocked','cancelled','unverified'].includes(run.status)) {
      response.write(`event: close\ndata: ${JSON.stringify({ status: run?.status ?? 'not_found' })}\n\n`);
      response.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function createApp({ db = new Database(), queue, codeRunner, liveTools, llm = createLLMRouter(), rateLimiter = new RateLimiter() } = {}) {
  const runQueue = queue ?? new RunQueue(db);
  runQueue.register('code.run', codeRunner ?? createCodeRunHandler(db));
  const tools = liveTools ?? createLiveToolRegistry({ db, codeRunner, llm });
  runQueue.register('agent.run', createAgentRunHandler({ db, tools, llm, costFor: modelCost }));
  const server = createServer(async (request, response) => {
    try {
      const origin = process.env.ALLOWED_ORIGIN ?? '';
      applySecurityHeaders(response, origin && request.headers.origin === origin ? origin : '');
      if (request.headers.origin && origin && request.headers.origin !== origin) throw new Error('CORS_ORIGIN_DENIED');
      if (!rateLimiter.allow(request.socket.remoteAddress ?? 'unknown')) throw new Error('RATE_LIMITED');
      if (request.method === 'OPTIONS') { response.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS'); response.setHeader('access-control-allow-headers', 'authorization,content-type'); return send(response, 204, {}); }
      const parts = routeParts(request.url);
      const method = request.method;
      if (method === 'GET' && parts[0] === 'health') return send(response, 200, { ok: true, service: 'ai-semo0o-agent-backend', time: now() });
      if (method === 'GET' && parts[0] === 'ready') {
        const providers = llm.status?.() ?? [];
        const ready = providers.some((provider) => provider.configured && provider.healthy !== false);
        return send(response, ready ? 200 : 503, { ok: ready, service: 'ai-semo0o-agent-backend', providers, time: now() });
      }
      if (method === 'POST' && parts.join('/') === 'auth/register') {
        const input = await body(request);
        const result = createUser(db, input);
        const session = createSession(db, result.id);
        issueAccountToken(db, result.id, 'email_verification');
        return send(response, 201, { user: { id: result.id, tenantId: result.tenant_id, email: result.email, role: result.role, emailVerified: false }, session, verificationRequired: true, delivery: 'NOT_VERIFIED_EMAIL_DELIVERY' });
      }
      if (method === 'POST' && parts.join('/') === 'auth/login') {
        const input = await body(request);
        return send(response, 200, authenticate(db, input.email, input.password, input.mfaCode));
      }
      if (method === 'POST' && parts.join('/') === 'auth/verify-email') {
        const input = await body(request); return send(response, 200, { user: verifyEmail(db, validateText(input.token, 'TOKEN', 256)) });
      }
      if (method === 'POST' && parts.join('/') === 'auth/request-password-reset') {
        const input = await body(request); const user = db.get('SELECT id FROM users WHERE lower(email)=lower(?)', validateText(input.email, 'EMAIL', 320));
        if (user) issueAccountToken(db, user.id, 'password_reset');
        return send(response, 202, { accepted: true, delivery: 'NOT_VERIFIED_EMAIL_DELIVERY' });
      }
      if (method === 'POST' && parts.join('/') === 'auth/reset-password') {
        const input = await body(request); resetPassword(db, validateText(input.token, 'TOKEN', 256), input.password, passwordHash); return send(response, 200, { ok: true });
      }
      const user = requireUser(db, request);
      if (method === 'GET' && parts.join('/') === 'tools/status') return send(response, 200, tools.status?.() ?? { live: [], catalogOnly: [], simulated: [], unwired: [] });
      if (method === 'GET' && parts.join('/') === 'models/status') return send(response, 200, { providers: llm.status?.() ?? [] });
      if (method === 'POST' && parts.join('/') === 'auth/logout') { revokeSession(db, user.sessionId); return send(response, 200, { ok: true }); }
      if (method === 'POST' && parts.join('/') === 'auth/mfa/setup') { return send(response, 200, enableMfa(db, user.id)); }
      if (method === 'POST' && parts.join('/') === 'auth/mfa/confirm') { const input = await body(request); return send(response, 200, confirmMfa(db, user.id, validateText(input.code, 'MFA_CODE', 6))); }
      if (method === 'POST' && parts.join('/') === 'org/invitations') {
        requireRole(user, ['owner', 'admin']); const input = await body(request); const invite = createInvitation(db, { tenantId: user.tenantId, invitedBy: user.id, email: input.email, role: input.role || 'member' }); return send(response, 201, { invitationId: invite.invitationId, expiresAt: invite.expiresAt, delivery: 'NOT_VERIFIED_EMAIL_DELIVERY' });
      }
      if (method === 'POST' && parts.join('/') === 'org/invitations/accept') { const input = await body(request); return send(response, 200, { membership: acceptInvitation(db, { token: validateText(input.token, 'TOKEN', 256), userId: user.id }) }); }
      if (method === 'POST' && parts.join('/') === 'chat') {
        const input = await body(request);
        const message = validateText(input.message, 'MESSAGE', 12000);
        const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : undefined;
        const result = await llm.complete({ model, messages: [
          { role: 'system', content: 'You are the Semo0o assistant. Answer naturally and accurately. Do not execute tools, claim external actions, or provide a medical diagnosis. Reply in Arabic when the user writes Arabic.' },
          { role: 'user', content: message },
        ] });
        db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'chat.completed', 'chat', user.id, JSON.stringify({ provider: result.provider, model: model || null, usage: result.usage }), now());
        return send(response, 200, { text: result.text, provider: result.provider, usage: result.usage });
      }
      if (method === 'POST' && parts[0] === 'projects' && parts.length === 1) {
        const input = await body(request);
        const name = validateText(input.name || 'Project', 'PROJECT_NAME');
        if (input.rootPath !== undefined && typeof input.rootPath !== 'string') throw new Error('INVALID_ROOT_PATH');
        const projectId = id('project'); const workspaceId = id('workspace'); const timestamp = now();
        const rootPath = resolveWorkspaceRoot(input.rootPath, projectId);
        await mkdir(rootPath, { recursive: true });
        db.transaction(() => {
          db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, user.tenantId, user.id, name, timestamp);
          db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, rootPath, timestamp);
        });
        return send(response, 201, { projectId, workspaceId });
      }
      if (method === 'GET' && parts[0] === 'projects' && parts[1]) {
        const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', parts[1], user.tenantId);
        assertProjectAccess(project, user);
        return send(response, 200, project);
      }
      if (method === 'POST' && parts[0] === 'runs' && parts.length === 1) {
        const input = await body(request);
        consumeQuota(db, user.tenantId, { runs: 1 });
        const kind = typeof input.kind === 'string' ? input.kind : 'code.run';
        const goal = validateText(input.goal || 'code execution', 'GOAL', 4000);
        const requestedIdempotencyKey = input.idempotencyKey ?? request.headers['idempotency-key'];
        const idempotencyKey = requestedIdempotencyKey ? validateText(requestedIdempotencyKey, 'IDEMPOTENCY_KEY', 128) : null;
        const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', input.projectId, user.tenantId);
        assertProjectAccess(project, user);
        const workspace = db.get('SELECT * FROM workspaces WHERE id=? AND project_id=?', input.workspaceId, input.projectId);
        if (!project || !workspace) throw new Error('NOT_FOUND');
        if (idempotencyKey) {
          const existing = db.get('SELECT * FROM runs WHERE tenant_id=? AND idempotency_key=?', user.tenantId, idempotencyKey);
          if (existing) return send(response, 202, { runId: existing.id, taskId: existing.task_id, status: existing.status, idempotent: true });
        }
        const taskId = id('task'); const timestamp = now(); const requiresApproval = requiresApprovalFor(kind, input);
        db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, user.tenantId, project.id, workspace.id, user.id, goal, requiresApproval ? 'waiting_approval' : 'queued', timestamp, timestamp);
        const run = requiresApproval ? db.transaction(() => {
          const runId = id('run');
          db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', runId, taskId, user.tenantId, 'waiting_approval', JSON.stringify({ kind, ...input }), 0, idempotencyKey, timestamp, timestamp);
          db.run('INSERT INTO approvals(id,run_id,requested_by,capability,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)', id('approval'), runId, user.id, 'code.execute', 'pending', String(input.approvalReason || 'Code execution'), timestamp);
          return db.get('SELECT * FROM runs WHERE id=?', runId);
        }) : runQueue.enqueue({ taskId, tenantId: user.tenantId, payload: input, kind, idempotencyKey });
        return send(response, 202, { runId: run.id, taskId, status: run.status });
      }
      if (parts[0] === 'runs' && parts[1]) {
        const run = runQueue.get(parts[1], user.tenantId);
        if (!run) throw new Error('NOT_FOUND');
        const task = assertRunAccess(db, run, user);
        if (method === 'GET' && parts.length === 2) return send(response, 200, { ...run, payload: JSON.parse(run.payload_json), result: run.result_json ? JSON.parse(run.result_json) : null, evidence: db.all('SELECT id,kind,payload_json,sha256,created_at FROM evidence WHERE run_id=? ORDER BY created_at', run.id), events: db.all('SELECT id,type,payload_json,created_at FROM run_events WHERE run_id=? ORDER BY created_at', run.id), usage: db.all('SELECT provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd FROM run_usage WHERE run_id=?', run.id) });
        if (method === 'GET' && parts[2] === 'events') return streamRunEvents(response, db, run.id, user.tenantId, request);
        if (method === 'POST' && parts[2] === 'cancel') { if (task.created_by !== user.id) requireRole(user, ['owner','admin']); return send(response, 200, runQueue.cancel(run.id, user.tenantId)); }
        if (method === 'POST' && parts[2] === 'retry') { if (task.created_by !== user.id) requireRole(user, ['owner','admin']); return send(response, 200, runQueue.retry(run.id, user.tenantId)); }
        if (method === 'POST' && parts[2] === 'pause') { if (task.created_by !== user.id) requireRole(user, ['owner','admin']); return send(response, 200, runQueue.pause(run.id, user.tenantId)); }
        if (method === 'POST' && parts[2] === 'resume') { if (task.created_by !== user.id) requireRole(user, ['owner','admin']); return send(response, 200, runQueue.resume(run.id, user.tenantId)); }
        if (method === 'POST' && parts[2] === 'approval') {
          requireRole(user, ['owner','admin']); const input = await body(request); const decision = input.decision;
          const taskOwner = db.get('SELECT created_by FROM tasks WHERE id=?', run.task_id)?.created_by;
          const approvalPayload = JSON.parse(run.payload_json);
          if (taskOwner === user.id && approvalPayload.kind !== 'agent.run') throw new Error('SELF_APPROVAL_FORBIDDEN');
          if (!['allow','deny','cancel'].includes(decision)) throw new Error('INVALID_APPROVAL');
          const next = decision === 'allow' ? 'queued' : 'blocked';
          db.transaction(() => {
            const approval = db.get('SELECT capability FROM approvals WHERE run_id=? AND decision=? ORDER BY created_at DESC LIMIT 1', run.id, 'pending');
            const payload = JSON.parse(run.payload_json);
            const checkpoint = run.checkpoint_json ? JSON.parse(run.checkpoint_json) : {};
            const approvedTools = new Set(payload.approvedTools || []);
            if (decision === 'allow' && approval?.capability) approvedTools.add(approval.capability);
            db.run('UPDATE approvals SET decision=?,decided_by=?,decided_at=? WHERE run_id=? AND decision=?', decision, user.id, now(), run.id, 'pending');
            db.run('UPDATE runs SET status=?,payload_json=?,updated_at=? WHERE id=? AND status=?', next, JSON.stringify({ ...payload, approvedTools: [...approvedTools], resumeFrom: checkpoint.stepIndex ?? 0 }), now(), run.id, 'waiting_approval');
            db.run('UPDATE tasks SET status=?,updated_at=? WHERE id=(SELECT task_id FROM runs WHERE id=?)', next, now(), run.id);
          });
          return send(response, 200, runQueue.get(run.id, user.tenantId));
        }
      }
      throw new Error('NOT_FOUND');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = ['UNAUTHORIZED','INVALID_CREDENTIALS','MFA_REQUIRED','MFA_CODE_INVALID'].includes(message) ? 401 : ['FORBIDDEN','CORS_ORIGIN_DENIED','SELF_APPROVAL_FORBIDDEN'].includes(message) ? 403 : ['NOT_FOUND'].includes(message) ? 404 : (message.startsWith('INVALID_') || ['INVALID_JSON','BODY_TOO_LARGE','WORKSPACE_ROOT_REQUIRED','WORKSPACE_PATH_OUTSIDE_ROOT'].includes(message)) ? 400 : message === 'RATE_LIMITED' ? 429 : 500;
      send(response, status, { error: status >= 500 ? 'INTERNAL_ERROR' : message });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 64;
  return { server, db, queue: runQueue };
}

if (process.argv[1]?.endsWith('backend/server.mjs')) {
  const db = new Database();
  const app = createApp({ db, liveTools: createLiveToolRegistry({ db }) });
  if (process.env.DISABLE_WORKER !== '1') app.queue.start();
  const port = Number(process.env.PORT || 8787);
  const shutdown = () => { app.queue.stop(); app.server.close(() => db.close()); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  app.server.listen(port, process.env.BIND_HOST || '127.0.0.1', () => console.log(`backend listening on ${port}`));
}
