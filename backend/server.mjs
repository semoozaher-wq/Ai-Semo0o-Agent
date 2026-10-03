import { createServer } from 'node:http';
import { Database, id, now } from './db/client.mjs';
import { authenticate, authenticateToken, createSession, createUser, revokeSession, requireRole } from './auth/security.mjs';
import { RunQueue } from './queue/queue.mjs';
import { createCodeRunHandler } from './runners/code-runner.mjs';
import { RateLimiter, applySecurityHeaders } from './security/http.mjs';
import { createLiveToolRegistry } from './tools/registry.mjs';

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

export function createApp({ db = new Database(), queue, codeRunner, liveTools, rateLimiter = new RateLimiter() } = {}) {
  const runQueue = queue ?? new RunQueue(db);
  runQueue.register('code.run', codeRunner ?? createCodeRunHandler(db));
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
      if (method === 'POST' && parts.join('/') === 'auth/register') {
        const input = await body(request);
        const result = createUser(db, input);
        const session = createSession(db, result.id);
        return send(response, 201, { user: { id: result.id, tenantId: result.tenant_id, email: result.email, role: result.role }, session });
      }
      if (method === 'POST' && parts.join('/') === 'auth/login') {
        const input = await body(request);
        return send(response, 200, authenticate(db, input.email, input.password));
      }
      const user = requireUser(db, request);
      if (method === 'GET' && parts.join('/') === 'tools/status') return send(response, 200, liveTools?.status?.() ?? { live: [], catalogOnly: [], simulated: [], unwired: [] });
      if (method === 'POST' && parts.join('/') === 'auth/logout') { revokeSession(db, user.sessionId); return send(response, 200, { ok: true }); }
      if (method === 'POST' && parts[0] === 'projects' && parts.length === 1) {
        const input = await body(request);
        const name = validateText(input.name || 'Project', 'PROJECT_NAME');
        if (input.rootPath !== undefined && typeof input.rootPath !== 'string') throw new Error('INVALID_ROOT_PATH');
        const projectId = id('project'); const workspaceId = id('workspace'); const timestamp = now();
        db.transaction(() => {
          db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, user.tenantId, user.id, name, timestamp);
          db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, '', timestamp);
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
        const kind = typeof input.kind === 'string' ? input.kind : 'code.run';
        const goal = validateText(input.goal || 'code execution', 'GOAL', 4000);
        const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', input.projectId, user.tenantId);
        assertProjectAccess(project, user);
        const workspace = db.get('SELECT * FROM workspaces WHERE id=? AND project_id=?', input.workspaceId, input.projectId);
        if (!project || !workspace) throw new Error('NOT_FOUND');
        const taskId = id('task'); const timestamp = now(); const requiresApproval = requiresApprovalFor(kind, input);
        db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, user.tenantId, project.id, workspace.id, user.id, goal, requiresApproval ? 'waiting_approval' : 'queued', timestamp, timestamp);
        const run = requiresApproval ? db.transaction(() => {
          const runId = id('run');
          db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, user.tenantId, 'waiting_approval', JSON.stringify({ kind, ...input }), 0, timestamp, timestamp);
          db.run('INSERT INTO approvals(id,run_id,requested_by,capability,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)', id('approval'), runId, user.id, 'code.execute', 'pending', String(input.approvalReason || 'Code execution'), timestamp);
          return db.get('SELECT * FROM runs WHERE id=?', runId);
        }) : runQueue.enqueue({ taskId, tenantId: user.tenantId, payload: input, kind });
        return send(response, 202, { runId: run.id, taskId, status: run.status });
      }
      if (parts[0] === 'runs' && parts[1]) {
        const run = runQueue.get(parts[1], user.tenantId);
        if (!run) throw new Error('NOT_FOUND');
        const task = assertRunAccess(db, run, user);
        if (method === 'GET' && parts.length === 2) return send(response, 200, { ...run, payload: JSON.parse(run.payload_json), result: run.result_json ? JSON.parse(run.result_json) : null, evidence: db.all('SELECT id,kind,payload_json,sha256,created_at FROM evidence WHERE run_id=? ORDER BY created_at', run.id) });
        if (method === 'POST' && parts[2] === 'cancel') { if (task.created_by !== user.id) requireRole(user, ['owner','admin']); return send(response, 200, runQueue.cancel(run.id, user.tenantId)); }
        if (method === 'POST' && parts[2] === 'pause') { if (task.created_by !== user.id) requireRole(user, ['owner','admin']); return send(response, 200, runQueue.pause(run.id, user.tenantId)); }
        if (method === 'POST' && parts[2] === 'resume') { if (task.created_by !== user.id) requireRole(user, ['owner','admin']); return send(response, 200, runQueue.resume(run.id, user.tenantId)); }
        if (method === 'POST' && parts[2] === 'approval') {
          requireRole(user, ['owner','admin']); const input = await body(request); const decision = input.decision;
          const taskOwner = db.get('SELECT created_by FROM tasks WHERE id=?', run.task_id)?.created_by;
          if (taskOwner === user.id) throw new Error('SELF_APPROVAL_FORBIDDEN');
          if (!['allow','deny','cancel'].includes(decision)) throw new Error('INVALID_APPROVAL');
          const next = decision === 'allow' ? 'queued' : 'blocked';
          db.transaction(() => { db.run('UPDATE approvals SET decision=?,decided_by=?,decided_at=? WHERE run_id=? AND decision=?', decision, user.id, now(), run.id, 'pending'); db.run('UPDATE runs SET status=?,updated_at=? WHERE id=? AND status=?', next, now(), run.id, 'waiting_approval'); db.run('UPDATE tasks SET status=?,updated_at=? WHERE id=(SELECT task_id FROM runs WHERE id=?)', next, now(), run.id); });
          return send(response, 200, runQueue.get(run.id, user.tenantId));
        }
      }
      throw new Error('NOT_FOUND');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'UNAUTHORIZED' ? 401 : ['FORBIDDEN','CORS_ORIGIN_DENIED','SELF_APPROVAL_FORBIDDEN'].includes(message) ? 403 : ['NOT_FOUND'].includes(message) ? 404 : (message.startsWith('INVALID_') || ['INVALID_JSON','BODY_TOO_LARGE'].includes(message)) ? 400 : message === 'RATE_LIMITED' ? 429 : 500;
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
  app.server.listen(port, process.env.BIND_HOST || '127.0.0.1', () => console.log(`backend listening on ${port}`));
}
