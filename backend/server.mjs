import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Database, id, now } from './db/client.mjs';
import { authenticate, authenticateToken, createSession, createUser, revokeSession, requireRole, passwordHash } from './auth/security.mjs';
import { acceptInvitation, consumeQuota, confirmMfa, createInvitation, enableMfa, issueAccountToken, resetPassword, verifyEmail } from './auth/lifecycle.mjs';
import { RunQueue } from './queue/queue.mjs';
import { createCodeRunHandler } from './runners/code-runner.mjs';
import { DistributedRateLimiter, applySecurityHeaders } from './security/http.mjs';
import { createLiveToolRegistry } from './tools/registry.mjs';
import { createLLMRouter } from './llm/providers.mjs';
import { createAgentRunHandler } from './agent/runtime.mjs';
import { modelCost, normalizeModelId } from './models/catalog.mjs';
import { MemoryStore } from './memory/store.mjs';
import { applyWebhookEvent, verifyWebhookSignature } from './billing/service.mjs';
import { assertEnv } from './config/env.mjs';

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
function rawBody(request, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) return;
      raw += chunk;
      if (raw.length > limit) { rejected = true; request.destroy(); reject(new Error('BODY_TOO_LARGE')); }
    });
    request.on('end', () => resolve(raw));
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

function usageSummary(db, tenantId, days = 30) {
  const safeDays = Math.max(1, Math.min(90, Number.isFinite(days) ? Math.floor(days) : 30));
  const period = new Date().toISOString().slice(0, 7);
  const quota = db.get('SELECT monthly_tokens,monthly_runs FROM usage_quotas WHERE tenant_id=?', tenantId)
    ?? { monthly_tokens: 100000, monthly_runs: 1000 };
  const counter = db.get('SELECT tokens,runs FROM usage_counters WHERE tenant_id=? AND period=?', tenantId, period)
    ?? { tokens: 0, runs: 0 };
  const since = new Date(Date.now() - safeDays * 86_400_000).toISOString();
  const daily = db.all(
    `SELECT substr(created_at,1,10) AS date,
            SUM(total_tokens) AS tokens,
            SUM(cost_usd) AS cost_usd,
            COUNT(*) AS runs
       FROM run_usage
      WHERE tenant_id=? AND created_at>=?
      GROUP BY date ORDER BY date ASC`,
    tenantId, since,
  ).map((row) => ({ date: row.date, tokens: row.tokens ?? 0, costUsd: row.cost_usd ?? 0, runs: row.runs ?? 0 }));
  const messageRows = db.all(
    `SELECT substr(created_at,1,10) AS date, COUNT(*) AS messages
       FROM messages WHERE tenant_id=? AND role='user' AND created_at>=?
      GROUP BY date`,
    tenantId, since,
  );
  const messagesByDate = new Map(messageRows.map((row) => [row.date, row.messages ?? 0]));
  const merged = daily.map((point) => ({ ...point, messages: messagesByDate.get(point.date) ?? 0 }));
  for (const [date, messages] of messagesByDate) {
    if (!daily.some((point) => point.date === date)) merged.push({ date, tokens: 0, costUsd: 0, runs: 0, messages });
  }
  merged.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const totals = merged.reduce((acc, point) => ({
    tokens: acc.tokens + point.tokens,
    costUsd: Number((acc.costUsd + point.costUsd).toFixed(6)),
    runs: acc.runs + point.runs,
    messages: acc.messages + point.messages,
  }), { tokens: 0, costUsd: 0, runs: 0, messages: 0 });
  return { period, days: safeDays, quota, counter, daily: merged, totals, generatedAt: now() };
}
function resolveWorkspaceRoot(requested, projectId) {
  const configured = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : null;
  // Fail closed in production: without a configured WORKSPACE_ROOT an operator could
  // let a client point a workspace at an arbitrary absolute path (e.g. /etc) and then
  // read/write outside the intended sandbox. Dev/test keep the permissive fallback.
  if (!configured && process.env.NODE_ENV === 'production') throw new Error('WORKSPACE_ROOT_REQUIRED');
  const candidate = requested ? path.resolve(requested) : configured ? path.join(configured, projectId) : null;
  if (!candidate) throw new Error('WORKSPACE_ROOT_REQUIRED');
  if (configured && candidate !== configured && !candidate.startsWith(`${configured}${path.sep}`)) throw new Error('WORKSPACE_PATH_OUTSIDE_ROOT');
  return candidate;
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

export function createApp({ db = new Database(), queue, codeRunner, liveTools, llm = createLLMRouter(), rateLimiter } = {}) {
  rateLimiter ??= new DistributedRateLimiter(db, { max: Number(process.env.RATE_LIMIT_MAX || 120) });
  const runQueue = queue ?? new RunQueue(db, { pollMs: Number(process.env.WORKER_POLL_MS || 250), maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS || 3), concurrency: Number(process.env.WORKER_CONCURRENCY || 1) });
  runQueue.register('code.run', codeRunner ?? createCodeRunHandler(db));
  const tools = liveTools ?? createLiveToolRegistry({ db, codeRunner, llm });
  const memory = new MemoryStore(db);
  runQueue.register('agent.run', createAgentRunHandler({ db, tools, llm, costFor: modelCost }));
  const server = createServer(async (request, response) => {
    const requestId = request.headers['x-request-id']?.toString().slice(0, 100) || id('req');
    response.setHeader('x-request-id', requestId);
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
      if (method === 'POST' && parts.join('/') === 'billing/webhook') {
        // Provider webhooks are unauthenticated but authenticated by HMAC signature
        // over the RAW body. Never parse before verifying, or the signature is meaningless.
        const raw = await rawBody(request);
        const signature = request.headers['stripe-signature'] ?? request.headers['x-billing-signature'] ?? '';
        verifyWebhookSignature(raw, String(signature), process.env.BILLING_WEBHOOK_SECRET);
        let event;
        try { event = JSON.parse(raw); } catch { throw new Error('INVALID_JSON'); }
        const provider = process.env.BILLING_PROVIDER || 'stripe';
        const result = applyWebhookEvent(db, { provider, eventId: event.id, eventType: event.type, payload: event });
        return send(response, 200, { received: true, ...result });
      }
      const user = requireUser(db, request);
      if (method === 'GET' && parts.join('/') === 'tools/status') return send(response, 200, tools.status?.() ?? { live: [], catalogOnly: [], simulated: [], unwired: [] });
      if (method === 'GET' && parts.join('/') === 'models/status') return send(response, 200, { providers: llm.status?.() ?? [] });
      if (method === 'GET' && parts.join('/') === 'usage') {
        const days = Number(new URL(request.url, 'http://localhost').searchParams.get('days')) || 30;
        return send(response, 200, usageSummary(db, user.tenantId, days));
      }
      if (method === 'POST' && parts.join('/') === 'auth/logout') { revokeSession(db, user.sessionId); return send(response, 200, { ok: true }); }
      if (method === 'GET' && parts.join('/') === 'me/export') {
        return send(response, 200, { user: { id: user.id, tenantId: user.tenantId, email: user.email, role: user.role }, projects: db.all('SELECT id,name,created_at FROM projects WHERE tenant_id=? ORDER BY created_at', user.tenantId), messages: db.all('SELECT id,project_id,role,content,created_at FROM messages WHERE tenant_id=? ORDER BY created_at', user.tenantId), memory: db.all('SELECT id,project_id,source,content,created_at FROM documents WHERE tenant_id=? ORDER BY created_at', user.tenantId), exportedAt: now() });
      }
      if (method === 'DELETE' && parts.join('/') === 'me') {
        const input = await body(request);
        if (input.confirmEmail?.toLowerCase() !== user.email.toLowerCase()) throw new Error('DELETE_CONFIRMATION_REQUIRED');
        db.transaction(() => { db.run('DELETE FROM projects WHERE tenant_id=?', user.tenantId); db.run('DELETE FROM tenants WHERE id=?', user.tenantId); });
        return send(response, 200, { deleted: true });
      }
      if (method === 'POST' && parts.join('/') === 'auth/mfa/setup') { return send(response, 200, enableMfa(db, user.id)); }
      if (method === 'POST' && parts.join('/') === 'auth/mfa/confirm') { const input = await body(request); return send(response, 200, confirmMfa(db, user.id, validateText(input.code, 'MFA_CODE', 6))); }
      if (method === 'POST' && parts.join('/') === 'org/invitations') {
        requireRole(user, ['owner', 'admin']); const input = await body(request); const invite = createInvitation(db, { tenantId: user.tenantId, invitedBy: user.id, email: input.email, role: input.role || 'member' }); return send(response, 201, { invitationId: invite.invitationId, expiresAt: invite.expiresAt, delivery: 'NOT_VERIFIED_EMAIL_DELIVERY' });
      }
      if (method === 'POST' && parts.join('/') === 'org/invitations/accept') { const input = await body(request); return send(response, 200, { membership: acceptInvitation(db, { token: validateText(input.token, 'TOKEN', 256), userId: user.id }) }); }
      if (method === 'POST' && parts.join('/') === 'chat') {
        const input = await body(request);
        const message = validateText(input.message, 'MESSAGE', 12000);
        const model = normalizeModelId(input.model);
        consumeQuota(db, user.tenantId, {});
        const result = await llm.complete({ model, messages: [
          { role: 'system', content: 'You are the Semo0o assistant. Answer naturally and accurately. Do not execute tools, claim external actions, or provide a medical diagnosis. Reply in Arabic when the user writes Arabic.' },
          { role: 'user', content: message },
        ] });
        const chatTokens = Number(result.usage?.totalTokens ?? result.usage?.total_tokens) || 0;
        if (chatTokens > 0) consumeQuota(db, user.tenantId, { tokens: chatTokens });
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
      if (method === 'GET' && parts[0] === 'projects' && parts[1] && parts.length === 2) {
        const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', parts[1], user.tenantId);
        assertProjectAccess(project, user);
        return send(response, 200, project);
      }
      if (parts[0] === 'projects' && parts[1] && parts[2] === 'memory') {
        const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', parts[1], user.tenantId); assertProjectAccess(project, user);
        if (method === 'POST' && parts.length === 3) { const input = await body(request); validateText(input.source || 'api', 'SOURCE', 200); validateText(input.content, 'CONTENT', 200000); return send(response, 201, memory.addDocument({ tenantId: user.tenantId, projectId: project.id, source: input.source || 'api', content: input.content })); }
        if (method === 'GET' && parts.length === 3) return send(response, 200, memory.search({ tenantId: user.tenantId, projectId: project.id, query: validateText(new URL(request.url, 'http://localhost').searchParams.get('q'), 'QUERY', 500), limit: 10 }));
        if (method === 'GET' && parts[3] === 'export') return send(response, 200, memory.exportProject(user.tenantId, project.id));
        if (method === 'POST' && parts[3] === 'reindex') return send(response, 200, memory.reindexProject(user.tenantId, project.id));
        if (method === 'DELETE' && parts.length === 3) { requireRole(user, ['owner', 'admin']); return send(response, 200, { deleted: memory.deleteProject(user.tenantId, project.id).changes }); }
      }
      if (method === 'POST' && parts[0] === 'runs' && parts.length === 1) {
        const input = await body(request);
        const kind = typeof input.kind === 'string' ? input.kind : 'code.run';
        if (!['code.run', 'agent.run'].includes(kind)) throw new Error('UNSUPPORTED_RUN_KIND');
        if (kind === 'agent.run' && input.model !== undefined && input.model !== 'test') input.model = normalizeModelId(input.model);
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
        consumeQuota(db, user.tenantId, { runs: 1 });
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
      const status = ['UNAUTHORIZED','INVALID_CREDENTIALS','MFA_REQUIRED','MFA_CODE_INVALID'].includes(message) ? 401 : ['FORBIDDEN','CORS_ORIGIN_DENIED','SELF_APPROVAL_FORBIDDEN'].includes(message) ? 403 : ['NOT_FOUND'].includes(message) ? 404 : ['MONTHLY_TOKEN_QUOTA_EXCEEDED','MONTHLY_RUN_QUOTA_EXCEEDED'].includes(message) ? 402 : (message.startsWith('INVALID_') || message.startsWith('UNSUPPORTED_') || message.startsWith('DELETE_') || message.startsWith('AGENT_') || ['INVALID_JSON','BODY_TOO_LARGE','WORKSPACE_ROOT_REQUIRED','WORKSPACE_PATH_OUTSIDE_ROOT','BILLING_WEBHOOK_INVALID','BILLING_WEBHOOK_SIGNATURE_INVALID'].includes(message)) ? 400 : message === 'RATE_LIMITED' ? 429 : 500;
      send(response, status, { error: status >= 500 ? 'INTERNAL_ERROR' : message });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 64;
  return { server, db, queue: runQueue };
}

if (process.argv[1]?.endsWith('backend/server.mjs')) {
  assertEnv();
  const db = new Database();
  const app = createApp({ db, liveTools: createLiveToolRegistry({ db }) });
  if (process.env.DISABLE_WORKER !== '1') app.queue.start();
  const port = Number(process.env.PORT || 8787);
  const shutdown = () => { app.queue.stop(); app.server.close(() => db.close()); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  app.server.listen(port, process.env.BIND_HOST || '127.0.0.1', () => console.log(`backend listening on ${port}`));
}
