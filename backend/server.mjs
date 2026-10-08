import { createServer } from 'node:http';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Database, id, now } from './db/client.mjs';
import { authenticate, authenticateToken, createSession, createUser, revokeSession, requireRole, passwordHash } from './auth/security.mjs';
import { acceptInvitation, consumeQuota, confirmMfa, createInvitation, enableMfa, issueAccountToken, resetPassword, verifyEmail } from './auth/lifecycle.mjs';
import { RunQueue } from './queue/queue.mjs';
import { TriggerScheduler, normalizeSchedule, computeNextRun, TRIGGER_KINDS, MISSED_RUN_POLICIES, isValidTimeZone } from './queue/scheduler.mjs';
import { createCodeRunHandler } from './runners/code-runner.mjs';
import { DistributedRateLimiter, applySecurityHeaders } from './security/http.mjs';
import { createLiveToolRegistry } from './tools/registry.mjs';
import { loadPluginsFromEnv } from './tools/plugins.mjs';
import { TOOL_BY_ID } from './agent/catalog.mjs';
import { listReflections } from './agent/reflection.mjs';
import { evaluateRun, evaluateRuns, compareRuns } from './agent/evaluation.mjs';
import { buildExperienceSnapshot, summarizeExperience, recoveryPriorFromSnapshot, strategyPriorFromSnapshot, executionPriorFromSnapshot } from './agent/experience.mjs';
import { learningSummary } from './agent/learning-loop.mjs';
import { riskPolicy, degradedCapabilities, validateStartupConfig } from './agent/safety.mjs';
import { createLLMRouter } from './llm/providers.mjs';
import { createAgentRunHandler } from './agent/runtime.mjs';
import { modelCost, normalizeModelId } from './models/catalog.mjs';
import { isRoutingSentinel } from './models/task-router.mjs';
import { redactDeep, collectKnownSecrets } from './secrets/vault.mjs';
import { MemoryStore } from './memory/store.mjs';
import { applyWebhookEvent, billingStatus, planById, requireBillingProvider, verifyWebhookSignature } from './billing/service.mjs';
import { billingProviderStatus } from './billing/stripe.mjs';
import { buildAuthorizeUrl, createGitHubClient, exchangeCodeForToken, getGitHubUser, githubStatus, parseRepoSlug } from './github/service.mjs';
import { consumeOAuthState, deleteGitHubConnection, getGitHubConnection, issueOAuthState, resolveGitHubToken, saveGitHubConnection } from './github/connections.mjs';
import { embeddingStatus } from './memory/embeddings.mjs';
import { assertEnv } from './config/env.mjs';
import { resolveBindHost } from './config/bind.mjs';
import { applyRuntimeDefaults, resolveWritableWorkspaceRoot } from './config/runtime-defaults.mjs';
import { createTelemetry } from './observability/telemetry.mjs';
import { isMetricsAuthorized, renderPrometheus } from './observability/metrics.mjs';
import { analyze as selfImproveAnalyze, applyProposal, detectSignals, monitor as selfImproveMonitor, rejectProposal, rollbackProposal } from './self-improve/engine.mjs';
import { getProposal, listEvents as listSelfImproveEvents, listProposals } from './self-improve/store.mjs';
import { enqueueEmail, listOutbox, processOutbox } from './notifications/outbox.mjs';
import { listInvitations, listMembers, removeMember, revokeInvitation, updateMemberRole } from './org/members.mjs';
import { runRetention } from './ops/retention.mjs';
import { deleteTenantAccount, deleteUserAccount } from './account/deletion.mjs';
import { evaluateAlerts, renderAlertMetrics } from './observability/alerts.mjs';
import { createErrorTracker, errorTrackerStatus } from './observability/error-tracking.mjs';
import { ChatStore } from './chat/store.mjs';
import { Capability, createExecutionEngine } from '../execution-core/engine.mjs';
import { provisionTaskWorkspace, createTaskEngineResolver } from '../execution-core/task-workspace.mjs';
import { createContinuationSupervisor } from './agent/long-running.mjs';
import { buildProjectIntelligence } from '../phase2-core/platform.mjs';
import { analyzeImpact, describeImpact } from '../phase2-core/impact.mjs';
import { buildChangeSet, describeChangeSet } from '../phase2-core/changeset.mjs';
import { CodebaseReasoner } from '../phase2-core/reasoning.mjs';
import { buildCapabilityScorecard, collectCapabilitySignals, describeScorecard, loadProofArtifacts, runAgentBenchmark } from './ops/capability-benchmark.mjs';
import { CreationStudio, CREATION_TERMINAL_STATES } from './creation/studio.mjs';
import { FORMATS as CREATION_FORMATS, PALETTES as CREATION_PALETTES } from './creation/brief.mjs';

const SERVICE_VERSION = '2.0.0';
const SERVICE_STARTED_AT = Date.now();

// Structured request logging is opt-in so that development and the test suite stay
// quiet. Operators enable it with LOG_FORMAT=json (or any LOG_LEVEL) in production.
function loggingEnabled(env = process.env) {
  return ['json', 'pretty'].includes(String(env.LOG_FORMAT ?? '').toLowerCase()) || Boolean(env.LOG_LEVEL);
}

// A readiness probe must reflect the real ability to serve traffic: the database
// must answer a query, a configured workspace must be writable, and at least one
// LLM provider must be configured and healthy. `/health` stays a liveness check.
async function readinessReport({ db, llm }) {
  const checks = {};
  try {
    const row = db.get('SELECT 1 AS ok');
    checks.database = { ok: row?.ok === 1 };
  } catch (error) {
    checks.database = { ok: false, error: error instanceof Error ? error.message : 'DATABASE_UNAVAILABLE' };
  }
  const workspaceRoot = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : null;
  if (!workspaceRoot) {
    // Development/test may run without a pinned workspace root; report it as
    // unconfigured rather than failing readiness (production requires it via env).
    checks.workspace = { ok: true, configured: false };
  } else {
    try {
      await access(workspaceRoot, fsConstants.W_OK);
      checks.workspace = { ok: true, configured: true, root: workspaceRoot };
    } catch {
      checks.workspace = { ok: false, configured: true, root: workspaceRoot, error: 'WORKSPACE_NOT_WRITABLE' };
    }
  }
  const providers = llm.status?.() ?? [];
  const providerOk = providers.some((provider) => provider.configured && provider.healthy !== false);
  checks.providers = { ok: providerOk, configured: providers.filter((provider) => provider.configured).length, total: providers.length };
  return { ok: checks.database.ok && checks.workspace.ok && checks.providers.ok, checks, providers };
}

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
// Stream a binary artefact (video/gif/zip) with a download filename. Used by the
// Creation Studio artefact routes; never JSON-wrapped so browsers can save it.
function sendBinary(response, status, buffer, contentType, filename) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': buffer.length,
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${filename}"`,
  });
  response.end(buffer);
}
function bearer(request) { const value = request.headers.authorization ?? ''; return value.startsWith('Bearer ') ? value.slice(7) : null; }
function requireUser(db, request) { const user = authenticateToken(db, bearer(request)); if (!user) throw new Error('UNAUTHORIZED'); return user; }
function routeParts(url) { return new URL(url, 'http://localhost').pathname.split('/').filter(Boolean); }
function validateText(value, name, max = 120) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`INVALID_${name.toUpperCase()}`);
  return value.trim();
}
// Whitelist + coerce the Creation Studio director options from an untrusted
// request body. Unknown keys are dropped and enums are validated against the
// canonical brief tables, so a bad option can never reach the render pipeline.
const CREATION_RESOLUTIONS = ['draft', 'standard', 'high', 'full'];
function creationOptions(input = {}) {
  const options = {};
  if (CREATION_FORMATS[input.format]) options.format = input.format;
  if (CREATION_PALETTES[input.palette]) options.palette = input.palette;
  if (CREATION_RESOLUTIONS.includes(input.resolution)) options.resolution = input.resolution;
  const duration = Number(input.duration);
  if (Number.isFinite(duration)) options.duration = Math.max(4, Math.min(300, duration));
  const fps = Number(input.fps);
  if (Number.isFinite(fps)) options.fps = Math.max(6, Math.min(30, Math.round(fps)));
  const quality = Number(input.quality);
  if (Number.isFinite(quality)) options.quality = Math.max(30, Math.min(95, Math.round(quality)));
  const gifFps = Number(input.gifFps);
  if (Number.isFinite(gifFps)) options.gifFps = Math.max(4, Math.min(24, Math.round(gifFps)));
  const gifMaxDimension = Number(input.gifMaxDimension);
  if (Number.isFinite(gifMaxDimension)) options.gifMaxDimension = Math.max(160, Math.min(1280, Math.round(gifMaxDimension)));
  if (typeof input.model === 'string' && input.model.trim()) options.model = input.model.trim().slice(0, 120);
  if (input.bundle === false) options.bundle = false;
  if (input.pngSequence === true) options.pngSequence = true;
  if (input.useImages === false) options.useImages = false;
  return options;
}
// Best-effort transactional email enqueue. Account lifecycle flows (register,
// password reset, invitations) must never fail because the outbox write failed;
// the caller reports the real delivery state from the return value (queued vs.
// NOT_VERIFIED_EMAIL_DELIVERY) so the API never claims an email was sent.
function safeEnqueueEmail(db, payload) {
  try {
    return enqueueEmail(db, payload);
  } catch {
    return null;
  }
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
// Present a scheduled trigger with its payload decoded (never expose raw JSON).
function triggerView(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json || '{}'); } catch { payload = {}; }
  return {
    id: row.id, tenantId: row.tenant_id, projectId: row.project_id, workspaceId: row.workspace_id,
    name: row.name, kind: row.kind, schedule: row.schedule, goal: row.goal, payload,
    timezone: row.timezone || 'UTC', missedRunPolicy: row.missed_run_policy || 'catchup',
    retryCount: row.retry_count ?? 0, maxRetries: row.max_retries ?? 3,
    enabled: row.enabled === 1, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    runCount: row.run_count, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
// Read-only Git state for a task's workspace, reusing the Phase 1 execution
// runtime. Evidence is written to a temp directory so the checkout stays clean.
async function taskGitRead(db, user, taskId, action) {
  const task = db.get('SELECT * FROM tasks WHERE id=? AND tenant_id=?', taskId, user.tenantId);
  if (!task) throw new Error('NOT_FOUND');
  const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', task.project_id, user.tenantId);
  assertProjectAccess(project, user);
  const workspace = db.get('SELECT * FROM workspaces WHERE id=?', task.workspace_id);
  const workspaceRoot = workspace?.root_path || process.env.WORKSPACE_ROOT;
  if (!workspaceRoot) throw new Error('WORKSPACE_ROOT_REQUIRED');
  const engine = await createExecutionEngine({
    workspacePath: workspaceRoot,
    evidenceDirectory: path.join(os.tmpdir(), 'semo0o-git-read', task.id),
    grants: [Capability.GIT_READ],
    limits: { timeoutMs: 30_000, maxOutputBytes: 2_000_000, memoryLimitMb: 2_048, cpuLimitSeconds: 30 },
  });
  if (action === 'diff') return engine.git.diff();
  if (action === 'branch') return engine.git.branch();
  return engine.git.status();
}

// One honest view of every optional connector, shared by `/integrations/status`
// and the capability scorecard so the two can never disagree.
function integrationStatusView({ db, user, tools }) {
  const toolStatus = tools.status?.() ?? { live: [], partial: [], unwired: [], failed: [], tools: [] };
  return {
    tools: { live: toolStatus.live ?? [], partial: toolStatus.partial ?? [], unwired: toolStatus.unwired ?? [], failed: toolStatus.failed ?? [] },
    billing: billingProviderStatus(process.env),
    github: { ...githubStatus(process.env), connection: getGitHubConnection(db, user.tenantId) },
    embeddings: embeddingStatus(process.env),
    errorTracking: errorTrackerStatus(process.env),
    browser: { cdpConfigured: Boolean(process.env.BROWSER_CDP_URL), localLaunch: process.env.BROWSER_LAUNCH_LOCAL === 'true' },
  };
}

// Resolve the on-disk root of a project's workspace (the code-intelligence
// endpoints reason over the real files, never a synthetic copy). Falls back to
// the configured WORKSPACE_ROOT, and fails closed when neither exists.
function projectWorkspaceRoot(db, user, projectId) {
  const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', projectId, user.tenantId);
  assertProjectAccess(project, user);
  const workspace = db.get('SELECT root_path FROM workspaces WHERE project_id=? ORDER BY created_at LIMIT 1', project.id);
  const root = workspace?.root_path || process.env.WORKSPACE_ROOT;
  if (!root) throw new Error('WORKSPACE_ROOT_REQUIRED');
  return path.resolve(root);
}

// A reader for the deep reasoner that can only read files INSIDE the workspace
// root, so lexical reference scanning can never escape the project.
function workspaceReader(root) {
  const base = path.resolve(root);
  return async (relative) => {
    const resolved = path.resolve(base, String(relative));
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error('PATH_OUTSIDE_WORKSPACE');
    return readFile(resolved, 'utf8');
  };
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
  let configured = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : null;
  // A configured root may point at an unmounted/unwritable path (for example
  // `/var/data/workspace` on Render's Free plan, where no disk is mounted). Left
  // as-is, every `POST /projects` failed with EACCES -> 500 INTERNAL_ERROR, which
  // is exactly why the Semo AI UI showed "فشل التشغيل التنفيذي عبر الـBackend"
  // before the agent run ever started. Repair it to a writable container default
  // (mirroring the database path fallback). Fail closed only when NO root is
  // configured in production: an operator must opt in to a workspace.
  if (configured) {
    const writable = resolveWritableWorkspaceRoot(process.env);
    if (writable) configured = writable;
  }
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

// Server-Sent Events for a Creation Studio job. Mirrors streamRunEvents but is
// backed by the in-memory job registry: it replays buffered events (so a client
// that connects late never misses a stage), then live-forwards until the job
// reaches a terminal state and closes the stream.
async function streamCreationEvents(response, studio, jobId, tenantId, request) {
  const initial = studio.events(jobId, tenantId, 0);
  if (!initial) throw new Error('CREATION_JOB_NOT_FOUND');
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let cursor = 0;
  let closed = false;
  request.on('close', () => { closed = true; });
  const flush = () => {
    const snapshot = studio.events(jobId, tenantId, cursor);
    if (!snapshot) return false;
    for (const event of snapshot.events) { cursor = event.seq; response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`); }
    return true;
  };
  const unsubscribe = studio.subscribe(jobId, () => { if (!closed) flush(); }, tenantId) || (() => {});
  try {
    flush();
    while (!closed) {
      const job = studio.get(jobId, tenantId);
      if (!job || CREATION_TERMINAL_STATES.has(job.status)) {
        flush();
        response.write(`event: close\ndata: ${JSON.stringify({ status: job?.status ?? 'not_found' })}\n\n`);
        response.end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    unsubscribe();
  }
}

export function createApp({ db = new Database(), queue, codeRunner, liveTools, llm = createLLMRouter(), rateLimiter, costFor = modelCost, modelRouter, secrets } = {}) {
  rateLimiter ??= new DistributedRateLimiter(db, { max: Number(process.env.RATE_LIMIT_MAX || 120) });
  // Known secret values are resolved once and shared by the queue (result_json)
  // and the agent runtime (evidence / events / checkpoint) so both persist
  // redacted data. Tests may inject an explicit `secrets` list.
  const knownSecrets = Array.isArray(secrets) ? secrets : collectKnownSecrets();
  const redact = (value) => redactDeep(value, knownSecrets);
  const runQueue = queue ?? new RunQueue(db, { pollMs: Number(process.env.WORKER_POLL_MS || 250), maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS || 3), concurrency: Number(process.env.WORKER_CONCURRENCY || 1), retryBackoffMs: Number(process.env.WORKER_RETRY_BACKOFF_MS || 1_000), retryBackoffMaxMs: Number(process.env.WORKER_RETRY_BACKOFF_MAX_MS || 60_000), redact });
  runQueue.register('code.run', codeRunner ?? createCodeRunHandler(db));
  const memory = new MemoryStore(db);
  const tools = liveTools ?? createLiveToolRegistry({ db, codeRunner, llm, engineAvailable: true, memory });
  const chat = new ChatStore(db);
  // Creation Studio: the async job layer behind /creation/*. It reuses the same
  // server LLM router (optional) and auto-detects configured media providers,
  // falling back to the deterministic Local Studio so a video is always produced.
  const creationStudio = new CreationStudio({ llm });
  // Optional Sentry-compatible error tracking. Null when unconfigured so we
  // never report a fake "errors are tracked" state.
  let errorTracker = null;
  try { errorTracker = createErrorTracker(process.env); } catch { errorTracker = null; }
  // Link every agent run to its isolated per-task workspace engine.
  const resolveEngine = createTaskEngineResolver({ db });
  // Long-running autonomy: the supervisor wraps the agent handler so a bounded
  // wall-clock stop (checkpointed mid-plan) is transparently resumed on a fresh
  // run instead of being reported as a failure. Bounded by AGENT_MAX_CONTINUATIONS.
  const continuation = createContinuationSupervisor({ db, queue: runQueue, maxContinuations: Number(process.env.AGENT_MAX_CONTINUATIONS || 5) });
  runQueue.register('agent.run', continuation.wrap(createAgentRunHandler({ db, tools, llm, costFor, resolveEngine, secrets: knownSecrets, longRunning: true, memory, ...(modelRouter ? { modelRouter } : {}) })));
  // Extension SDK: load operator-provided tool plugins (TOOL_PLUGINS_DIR) into the
  // live registry. Fail-soft and isolated: a broken plugin is reported, never
  // fatal, and it can never overwrite a first-party tool id.
  const pluginsReady = loadPluginsFromEnv({ registry: tools, reservedIds: new Set(TOOL_BY_ID.keys()) })
    .catch(() => ({ loaded: [], failed: [], skipped: [] }));
  // Scheduled / recurring autonomy. Constructed here (side-effect free) so the
  // trigger routes can use it; started alongside the queue below.
  const scheduler = new TriggerScheduler(db, {
    queue: runQueue,
    pollMs: Number(process.env.TRIGGER_POLL_MS || 30_000),
    maxPerTick: Number(process.env.TRIGGER_MAX_PER_TICK || 50),
    concurrency: Number(process.env.TRIGGER_CONCURRENCY || 5),
    maxRetries: Number(process.env.TRIGGER_MAX_RETRIES || 3),
    retryBackoffMs: Number(process.env.TRIGGER_RETRY_BACKOFF_MS || 60_000),
    retryBackoffMaxMs: Number(process.env.TRIGGER_RETRY_BACKOFF_MAX_MS || 3_600_000),
  });
  const server = createServer(async (request, response) => {
    const requestId = request.headers['x-request-id']?.toString().slice(0, 100) || id('req');
    response.setHeader('x-request-id', requestId);
    try {
      const origin = process.env.ALLOWED_ORIGIN ?? '';
      applySecurityHeaders(response, origin && request.headers.origin === origin ? origin : '');
      if (request.headers.origin && origin && request.headers.origin !== origin) throw new Error('CORS_ORIGIN_DENIED');
      if (!rateLimiter.allow(request.socket.remoteAddress ?? 'unknown')) throw new Error('RATE_LIMITED');
      if (request.method === 'OPTIONS') { response.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS'); response.setHeader('access-control-allow-headers', 'authorization,content-type,x-request-id'); response.setHeader('access-control-max-age', '600'); return send(response, 204, {}); }
      const parts = routeParts(request.url);
      const method = request.method;
      if (method === 'GET' && parts[0] === 'health') return send(response, 200, { ok: true, service: 'ai-semo0o-agent-backend', version: SERVICE_VERSION, uptimeSeconds: Math.round((Date.now() - SERVICE_STARTED_AT) / 1000), time: now() });
      if (method === 'GET' && parts[0] === 'ready') {
        const report = await readinessReport({ db, llm });
        return send(response, report.ok ? 200 : 503, { ok: report.ok, service: 'ai-semo0o-agent-backend', version: SERVICE_VERSION, checks: report.checks, providers: report.providers, time: now() });
      }
      if (method === 'GET' && parts.join('/') === 'metrics') {
        // Prometheus scrape endpoint: reachable from loopback or with the
        // configured METRICS_TOKEN. Never exposed to unauthenticated public callers.
        if (!isMetricsAuthorized({ remoteAddress: request.socket.remoteAddress ?? '', token: bearer(request), expectedToken: process.env.METRICS_TOKEN ?? '' })) throw new Error('UNAUTHORIZED');
        const windowHours = Math.max(1, Math.min(24 * 30, Number(new URL(request.url, 'http://localhost').searchParams.get('windowHours')) || 24));
        // Evaluate alerts once and reuse its metrics/SLO so /metrics also carries
        // the currently-firing alert series for an external Alertmanager.
        const report = evaluateAlerts(db, { windowHours });
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`${renderPrometheus(report.metrics, report.slo)}${renderAlertMetrics(report.firing)}`);
        return;
      }
      if (method === 'POST' && parts.join('/') === 'auth/register') {
        const input = await body(request);
        const result = createUser(db, input);
        const session = createSession(db, result.id);
        const token = issueAccountToken(db, result.id, 'email_verification');
        const outbox = safeEnqueueEmail(db, { tenantId: result.tenant_id, to: result.email, template: 'email_verification', body: `Verify your email with this token: ${token}` });
        return send(response, 201, { user: { id: result.id, tenantId: result.tenant_id, email: result.email, role: result.role, emailVerified: false }, session, verificationRequired: true, delivery: outbox ? 'queued' : 'NOT_VERIFIED_EMAIL_DELIVERY', outboxId: outbox?.outboxId ?? null });
      }
      if (method === 'POST' && parts.join('/') === 'auth/login') {
        const input = await body(request);
        return send(response, 200, authenticate(db, input.email, input.password, input.mfaCode));
      }
      if (method === 'POST' && parts.join('/') === 'auth/verify-email') {
        const input = await body(request); return send(response, 200, { user: verifyEmail(db, validateText(input.token, 'TOKEN', 256)) });
      }
      if (method === 'POST' && parts.join('/') === 'auth/request-password-reset') {
        const input = await body(request); const user = db.get('SELECT id,tenant_id,email FROM users WHERE lower(email)=lower(?)', validateText(input.email, 'EMAIL', 320));
        let outbox = null;
        if (user) {
          const token = issueAccountToken(db, user.id, 'password_reset');
          outbox = safeEnqueueEmail(db, { tenantId: user.tenant_id, to: user.email, template: 'password_reset', body: `Reset your Semo AI password with this token: ${token}` });
        }
        // Always 202 with a generic body so the endpoint cannot be used to
        // enumerate which email addresses have accounts.
        return send(response, 202, { accepted: true, delivery: outbox ? 'queued' : 'NOT_VERIFIED_EMAIL_DELIVERY', outboxId: outbox?.outboxId ?? null });
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
      // --- Creation Studio (AI Creation platform) --------------------------
      // One goal in, a real deliverable out. The Studio runs the autonomous
      // Director (think -> plan -> render -> critique -> improve -> deliver) as
      // an observable async job. All routes are tenant-scoped.
      if (parts[0] === 'creation') {
        if (method === 'GET' && parts[1] === 'capabilities') return send(response, 200, creationStudio.capabilities());
        if (method === 'GET' && parts[1] === 'jobs' && parts.length === 2) return send(response, 200, { jobs: creationStudio.list(user.tenantId) });
        if (method === 'POST' && parts[1] === 'jobs' && parts.length === 2) {
          const input = await body(request);
          const goal = validateText(input.goal, 'GOAL', 4000);
          const options = creationOptions(input);
          return send(response, 202, creationStudio.start({ goal, tenantId: user.tenantId, userId: user.id, options }));
        }
        if (method === 'POST' && parts[1] === 'plan' && parts.length === 2) {
          const input = await body(request);
          const goal = validateText(input.goal, 'GOAL', 4000);
          return send(response, 200, await creationStudio.plan(goal, creationOptions(input)));
        }
        if (parts[1] === 'jobs' && parts.length >= 3) {
          const jobId = parts[2];
          if (method === 'GET' && parts.length === 3) {
            const view = creationStudio.status(jobId, user.tenantId);
            if (!view) throw new Error('CREATION_JOB_NOT_FOUND');
            return send(response, 200, view);
          }
          if (method === 'GET' && parts[3] === 'events') {
            if (String(request.headers.accept ?? '').includes('text/event-stream')) return streamCreationEvents(response, creationStudio, jobId, user.tenantId, request);
            const snapshot = creationStudio.events(jobId, user.tenantId, Number(new URL(request.url, 'http://localhost').searchParams.get('since')) || 0);
            if (!snapshot) throw new Error('CREATION_JOB_NOT_FOUND');
            return send(response, 200, { jobId, status: snapshot.job.status, events: snapshot.events });
          }
          if (method === 'GET' && parts[3] === 'artifacts' && parts.length === 5) {
            const artifact = creationStudio.artifact(jobId, parts[4], user.tenantId);
            if (!artifact) throw new Error('CREATION_ARTIFACT_NOT_FOUND');
            return sendBinary(response, 200, artifact.buffer, artifact.mimeType, artifact.filename);
          }
          if (method === 'POST' && parts[3] === 'cancel' && parts.length === 4) {
            const view = creationStudio.cancel(jobId, user.tenantId);
            if (!view) throw new Error('CREATION_JOB_NOT_FOUND');
            return send(response, 200, view);
          }
        }
        throw new Error('NOT_FOUND');
      }
      if (method === 'GET' && parts.join('/') === 'tools/status') {
        const status = tools.status?.() ?? { live: [], partial: [], catalogOnly: [], simulated: [], unwired: [], failed: [], dangerous: [], tools: [] };
        const summary = { live: status.live?.length ?? 0, partial: status.partial?.length ?? 0, unwired: status.unwired?.length ?? 0, failed: status.failed?.length ?? 0, catalogOnly: status.catalogOnly?.length ?? 0, simulated: status.simulated?.length ?? 0, dangerous: status.dangerous?.length ?? 0 };
        return send(response, 200, { ...status, summary });
      }
      if (method === 'GET' && parts.join('/') === 'models/status') return send(response, 200, { providers: llm.status?.() ?? [] });
      if (method === 'GET' && parts.join('/') === 'usage') {
        const days = Number(new URL(request.url, 'http://localhost').searchParams.get('days')) || 30;
        return send(response, 200, usageSummary(db, user.tenantId, days));
      }
      if (method === 'GET' && parts.join('/') === 'billing/status') {
        return send(response, 200, billingStatus(db, user.tenantId));
      }
      if (method === 'POST' && parts.join('/') === 'billing/checkout') {
        requireRole(user, ['owner', 'admin']);
        const input = await body(request);
        const plan = planById(validateText(input.planId, 'PLAN_ID', 32));
        if (plan.id === 'free') throw new Error('BILLING_PLAN_NOT_PURCHASABLE');
        const priceId = input.priceId || process.env[`STRIPE_PRICE_${plan.id.toUpperCase()}`];
        if (!priceId) throw new Error('BILLING_PRICE_NOT_CONFIGURED');
        const adapter = requireBillingProvider(process.env);
        const existing = db.get('SELECT provider_customer_id FROM subscriptions WHERE tenant_id=? AND provider=? AND provider_customer_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1', user.tenantId, adapter.id);
        let customerId = existing?.provider_customer_id ?? null;
        if (!customerId) {
          const created = await adapter.createCustomer({ email: user.email, tenantId: user.tenantId, name: user.tenantId });
          customerId = created.customerId;
          const timestamp = now();
          db.run('INSERT INTO subscriptions(id,tenant_id,provider,provider_customer_id,plan_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', id('subscription'), user.tenantId, adapter.id, customerId, plan.id, 'incomplete', timestamp, timestamp);
        }
        const origin = process.env.PUBLIC_APP_URL || 'http://localhost:8081';
        const session = await adapter.createCheckoutSession({
          customerId, priceId, tenantId: user.tenantId, planId: plan.id,
          successUrl: input.successUrl || `${origin}/billing/success`,
          cancelUrl: input.cancelUrl || `${origin}/billing/cancel`,
        });
        db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'billing.checkout.created', 'billing', user.id, JSON.stringify({ provider: adapter.id, plan: plan.id, sessionId: session.sessionId }), now());
        return send(response, 200, { url: session.url, sessionId: session.sessionId, provider: adapter.id });
      }
      if (method === 'POST' && parts.join('/') === 'billing/portal') {
        requireRole(user, ['owner', 'admin']);
        const input = await body(request);
        const adapter = requireBillingProvider(process.env);
        const sub = db.get('SELECT provider_customer_id FROM subscriptions WHERE tenant_id=? AND provider=? AND provider_customer_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1', user.tenantId, adapter.id);
        if (!sub?.provider_customer_id) throw new Error('BILLING_CUSTOMER_NOT_FOUND');
        const session = await adapter.createPortalSession({ customerId: sub.provider_customer_id, returnUrl: input.returnUrl || process.env.PUBLIC_APP_URL || 'http://localhost:8081' });
        return send(response, 200, { url: session.url, provider: adapter.id });
      }
      if (method === 'POST' && parts.join('/') === 'billing/subscription/cancel') {
        requireRole(user, ['owner', 'admin']);
        const adapter = requireBillingProvider(process.env);
        const sub = db.get('SELECT provider_subscription_id FROM subscriptions WHERE tenant_id=? AND provider=? AND provider_subscription_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1', user.tenantId, adapter.id);
        if (!sub?.provider_subscription_id) throw new Error('BILLING_SUBSCRIPTION_NOT_FOUND');
        const result = await adapter.cancelSubscription({ subscriptionId: sub.provider_subscription_id });
        db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'billing.subscription.canceled', 'billing', user.id, JSON.stringify({ provider: adapter.id, subscriptionId: sub.provider_subscription_id }), now());
        return send(response, 200, result);
      }
      if (method === 'GET' && parts.join('/') === 'integrations/status') {
        // One honest view of every optional connector so the UI and operators can
        // see exactly what is live versus fail-closed, never a fake success.
        const toolStatus = tools.status?.() ?? { live: [], partial: [], unwired: [], failed: [], tools: [] };
        return send(response, 200, {
          tools: { live: toolStatus.live ?? [], partial: toolStatus.partial ?? [], unwired: toolStatus.unwired ?? [], failed: toolStatus.failed ?? [] },
          billing: billingProviderStatus(process.env),
          github: { ...githubStatus(process.env), connection: getGitHubConnection(db, user.tenantId) },
          embeddings: embeddingStatus(process.env),
          errorTracking: errorTrackerStatus(process.env),
          browser: { cdpConfigured: Boolean(process.env.BROWSER_CDP_URL), localLaunch: process.env.BROWSER_LAUNCH_LOCAL === 'true' },
        });
      }
      if (method === 'GET' && parts.join('/') === 'github/status') {
        return send(response, 200, { ...githubStatus(process.env), connection: getGitHubConnection(db, user.tenantId) });
      }
      if (method === 'POST' && parts.join('/') === 'github/oauth/start') {
        requireRole(user, ['owner', 'admin']);
        const status = githubStatus(process.env);
        if (!status.oauthConfigured) throw new Error('GITHUB_OAUTH_NOT_CONFIGURED');
        const state = issueOAuthState(db, user.id);
        const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI || `${process.env.PUBLIC_APP_URL || 'http://localhost:8081'}/github/callback`;
        return send(response, 200, { url: buildAuthorizeUrl({ clientId: process.env.GITHUB_OAUTH_CLIENT_ID, redirectUri, state }), state });
      }
      if (method === 'POST' && parts.join('/') === 'github/oauth/complete') {
        requireRole(user, ['owner', 'admin']);
        const input = await body(request);
        consumeOAuthState(db, user.id, validateText(input.state, 'STATE', 512));
        const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI || `${process.env.PUBLIC_APP_URL || 'http://localhost:8081'}/github/callback`;
        const token = await exchangeCodeForToken({ clientId: process.env.GITHUB_OAUTH_CLIENT_ID, clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET, code: validateText(input.code, 'CODE', 512), redirectUri });
        const ghUser = await getGitHubUser({ token: token.token });
        const connection = saveGitHubConnection(db, { tenantId: user.tenantId, userId: user.id, login: ghUser.login, scope: token.scope, token: token.token });
        db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'github.oauth.connected', 'github', user.id, JSON.stringify({ login: ghUser.login, scope: token.scope }), now());
        return send(response, 200, { connected: true, login: connection.login, scope: connection.scope });
      }
      if (method === 'DELETE' && parts.join('/') === 'github/connection') {
        requireRole(user, ['owner', 'admin']);
        const removed = deleteGitHubConnection(db, user.tenantId);
        db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'github.oauth.disconnected', 'github', user.id, '{}', now());
        return send(response, 200, { disconnected: true, removed: removed.changes });
      }
      if (parts[0] === 'github' && parts[1] === 'repos' && parts[2] && method === 'POST') {
        requireRole(user, ['owner', 'admin']);
        const { owner, repo } = parseRepoSlug(`${parts[2]}/${parts[3] ?? ''}`.replace(/\/$/, ''));
        const token = resolveGitHubToken(db, user.tenantId);
        if (!token) throw new Error('GITHUB_NOT_CONFIGURED');
        const client = createGitHubClient({ token });
        const input = await body(request);
        const action = parts[4];
        if (action === 'issues') {
          if (input.number) return send(response, 200, await client.commentOnIssue({ owner, repo, issueNumber: input.number, body: validateText(input.body, 'BODY', 100000) }));
          return send(response, 201, await client.createIssue({ owner, repo, title: validateText(input.title, 'TITLE', 256), body: typeof input.body === 'string' ? input.body.slice(0, 100000) : '', labels: Array.isArray(input.labels) ? input.labels.slice(0, 20).map((label) => String(label).slice(0, 64)) : [] }));
        }
        if (action === 'pulls') {
          return send(response, 201, await client.createPullRequest({ owner, repo, title: validateText(input.title, 'TITLE', 256), head: validateText(input.head, 'HEAD', 256), base: validateText(input.base, 'BASE', 256), body: typeof input.body === 'string' ? input.body.slice(0, 100000) : '', draft: input.draft === true }));
        }
        if (action === 'info') return send(response, 200, await client.getRepo({ owner, repo }));
        throw new Error('GITHUB_ACTION_UNSUPPORTED');
      }
      if (method === 'POST' && parts.join('/') === 'auth/logout') { revokeSession(db, user.sessionId); return send(response, 200, { ok: true }); }
      if (method === 'GET' && parts.join('/') === 'me') {
        // The caller's own profile, including the REAL MFA state so the account
        // UI can show whether a second factor is active instead of assuming it.
        const profile = db.get('SELECT id,tenant_id,email,role,mfa_enabled,email_verified_at,created_at FROM users WHERE id=?', user.id);
        if (!profile) throw new Error('ACCOUNT_NOT_FOUND');
        return send(response, 200, {
          user: {
            id: profile.id,
            tenantId: profile.tenant_id,
            email: profile.email,
            role: profile.role,
            mfaEnabled: Boolean(profile.mfa_enabled),
            emailVerifiedAt: profile.email_verified_at ?? null,
            createdAt: profile.created_at,
          },
        });
      }
      if (method === 'GET' && parts.join('/') === 'me/export') {
        // A complete, self-service data export (GDPR/CCPA style). Runs, audit
        // entries, and outbox rows are scoped to the caller's own identity so a
        // member cannot export another member's activity.
        return send(response, 200, {
          user: { id: user.id, tenantId: user.tenantId, email: user.email, role: user.role },
          memberships: db.all('SELECT tenant_id, role, status, created_at FROM tenant_members WHERE user_id=?', user.id),
          projects: db.all('SELECT id,name,created_at FROM projects WHERE tenant_id=? ORDER BY created_at', user.tenantId),
          messages: db.all('SELECT id,project_id,role,content,created_at FROM messages WHERE tenant_id=? AND user_id=? ORDER BY created_at', user.tenantId, user.id),
          conversations: db.all('SELECT id,title,mode,status,created_at,updated_at FROM conversations WHERE tenant_id=? AND user_id=? ORDER BY created_at', user.tenantId, user.id),
          chatMessages: db.all('SELECT id,conversation_id,role,content,status,created_at FROM chat_messages WHERE tenant_id=? AND user_id=? ORDER BY created_at', user.tenantId, user.id),
          memory: db.all('SELECT id,project_id,source,content,created_at FROM documents WHERE tenant_id=? ORDER BY created_at', user.tenantId),
          runs: db.all('SELECT r.id,r.status,r.created_at,r.updated_at FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.tenant_id=? AND t.created_by=? ORDER BY r.created_at', user.tenantId, user.id),
          usage: usageSummary(db, user.tenantId, 90),
          audit: db.all('SELECT action,resource_type,resource_id,created_at FROM audit_logs WHERE tenant_id=? AND user_id=? ORDER BY created_at', user.tenantId, user.id),
          outbox: db.all('SELECT id,to_email,template,status,created_at FROM email_outbox WHERE tenant_id=? AND lower(to_email)=lower(?) ORDER BY created_at', user.tenantId, user.email),
          exportedAt: now(),
        });
      }
      if (method === 'DELETE' && parts.join('/') === 'me') {
        const input = await body(request);
        if (input.confirmEmail?.toLowerCase() !== user.email.toLowerCase()) throw new Error('DELETE_CONFIRMATION_REQUIRED');
        // `scope: 'tenant'` erases the whole tenant (owner-only). The default,
        // `scope: 'self'`, erases only the caller's account and personal data —
        // the operation a non-owner member needs, which previously always 403'd.
        if (input.scope === 'tenant') {
          requireRole(user, ['owner']);
          const result = deleteTenantAccount(db, { tenantId: user.tenantId, userId: user.id, force: input.force === true });
          return send(response, 200, { deleted: true, ...result });
        }
        const result = deleteUserAccount(db, { tenantId: user.tenantId, userId: user.id, transferOwnershipTo: input.transferOwnershipTo ?? null });
        return send(response, 200, { deleted: true, ...result });
      }
      if (method === 'POST' && parts.join('/') === 'ops/retention/run') {
        requireRole(user, ['owner', 'admin']);
        return send(response, 200, runRetention(db, {}));
      }
      if (method === 'GET' && parts.join('/') === 'ops/alerts') {
        requireRole(user, ['owner', 'admin']);
        const windowHours = Math.max(1, Math.min(24 * 30, Number(new URL(request.url, 'http://localhost').searchParams.get('windowHours')) || 24));
        const report = evaluateAlerts(db, { windowHours });
        // Do not leak the full metrics blob in the alert view; the SLO summary and
        // the firing set are what an operator acts on.
        return send(response, 200, {
          windowHours: report.windowHours,
          generatedAt: report.generatedAt,
          ok: report.ok,
          highestSeverity: report.highestSeverity,
          firing: report.firing,
          alerts: report.alerts,
          slo: report.slo,
        });
      }
      if (method === 'POST' && parts.join('/') === 'auth/mfa/setup') { return send(response, 200, enableMfa(db, user.id)); }
      if (method === 'POST' && parts.join('/') === 'auth/mfa/confirm') { const input = await body(request); return send(response, 200, confirmMfa(db, user.id, validateText(input.code, 'MFA_CODE', 6))); }
      if (method === 'POST' && parts.join('/') === 'org/invitations') {
        requireRole(user, ['owner', 'admin']); const input = await body(request); const invite = createInvitation(db, { tenantId: user.tenantId, invitedBy: user.id, email: input.email, role: input.role || 'member' });
        const outbox = safeEnqueueEmail(db, { tenantId: user.tenantId, to: invite.email ?? input.email, template: 'invitation', body: `You have been invited to a Semo AI workspace. Accept with this token: ${invite.token}` });
        return send(response, 201, { invitationId: invite.invitationId, expiresAt: invite.expiresAt, delivery: outbox ? 'queued' : 'NOT_VERIFIED_EMAIL_DELIVERY', outboxId: outbox?.outboxId ?? null });
      }
      if (method === 'POST' && parts.join('/') === 'org/invitations/accept') { const input = await body(request); return send(response, 200, { membership: acceptInvitation(db, { token: validateText(input.token, 'TOKEN', 256), userId: user.id }) }); }
      // --- Organization / membership management (owner/admin) ----------------
      if (method === 'GET' && parts.join('/') === 'org/members') {
        requireRole(user, ['owner', 'admin']);
        return send(response, 200, { members: listMembers(db, user.tenantId) });
      }
      if (method === 'PATCH' && parts[0] === 'org' && parts[1] === 'members' && parts[2] && parts.length === 3) {
        requireRole(user, ['owner', 'admin']);
        const input = await body(request);
        return send(response, 200, { member: updateMemberRole(db, { tenantId: user.tenantId, userId: parts[2], role: validateText(input.role, 'ROLE', 16), actorId: user.id }) });
      }
      if (method === 'DELETE' && parts[0] === 'org' && parts[1] === 'members' && parts[2] && parts.length === 3) {
        requireRole(user, ['owner', 'admin']);
        return send(response, 200, removeMember(db, { tenantId: user.tenantId, userId: parts[2], actorId: user.id }));
      }
      if (method === 'GET' && parts.join('/') === 'org/invitations') {
        requireRole(user, ['owner', 'admin']);
        return send(response, 200, { invitations: listInvitations(db, user.tenantId) });
      }
      if (method === 'DELETE' && parts[0] === 'org' && parts[1] === 'invitations' && parts[2] && parts.length === 3) {
        requireRole(user, ['owner', 'admin']);
        return send(response, 200, revokeInvitation(db, { tenantId: user.tenantId, invitationId: parts[2], actorId: user.id }));
      }
      // --- Self-improvement / self-healing engine -----------------------------
      // Read-only signal detection is available to any member; every mutating
      // action (analyze/approve/reject/rollback/monitor) requires owner or admin.
      if (method === 'GET' && parts.join('/') === 'self-improve/signals') {
        const windowHours = Math.max(1, Math.min(24 * 30, Number(new URL(request.url, 'http://localhost').searchParams.get('windowHours')) || 168));
        return send(response, 200, { signals: detectSignals(db, { tenantId: user.tenantId, windowHours }), windowHours });
      }
      if (method === 'POST' && parts.join('/') === 'self-improve/analyze') {
        requireRole(user, ['owner', 'admin']);
        const input = await body(request);
        const windowHours = Math.max(1, Math.min(24 * 30, Number(input.windowHours) || 168));
        const minOccurrences = Math.max(1, Math.min(50, Number(input.minOccurrences) || 2));
        return send(response, 200, selfImproveAnalyze(db, { tenantId: user.tenantId, windowHours, minOccurrences, autoCreate: true, createdBy: user.id }));
      }
      if (method === 'GET' && parts.join('/') === 'self-improve/proposals') {
        const status = new URL(request.url, 'http://localhost').searchParams.get('status') || undefined;
        return send(response, 200, { proposals: listProposals(db, user.tenantId, { status }) });
      }
      if (method === 'GET' && parts[0] === 'self-improve' && parts[1] === 'proposals' && parts[2] && parts.length === 3) {
        const proposal = getProposal(db, user.tenantId, parts[2]);
        if (!proposal) throw new Error('NOT_FOUND');
        return send(response, 200, { proposal, events: listSelfImproveEvents(db, user.tenantId, { proposalId: proposal.id }) });
      }
      if (method === 'POST' && parts[0] === 'self-improve' && parts[1] === 'proposals' && parts[3] === 'approve') {
        requireRole(user, ['owner', 'admin']);
        return send(response, 200, { proposal: applyProposal(db, { tenantId: user.tenantId, proposalId: parts[2], decidedBy: user.id }) });
      }
      if (method === 'POST' && parts[0] === 'self-improve' && parts[1] === 'proposals' && parts[3] === 'reject') {
        requireRole(user, ['owner', 'admin']);
        const input = await body(request).catch(() => ({}));
        return send(response, 200, { proposal: rejectProposal(db, { tenantId: user.tenantId, proposalId: parts[2], decidedBy: user.id, reason: input.reason }) });
      }
      if (method === 'POST' && parts[0] === 'self-improve' && parts[1] === 'proposals' && parts[3] === 'rollback') {
        requireRole(user, ['owner', 'admin']);
        const input = await body(request).catch(() => ({}));
        return send(response, 200, { proposal: rollbackProposal(db, { tenantId: user.tenantId, proposalId: parts[2], decidedBy: user.id, reason: input.reason || 'manual rollback' }) });
      }
      if (method === 'POST' && parts.join('/') === 'self-improve/monitor') {
        requireRole(user, ['owner', 'admin']);
        return send(response, 200, selfImproveMonitor(db, { tenantId: user.tenantId }));
      }
      if (method === 'GET' && parts.join('/') === 'self-improve/history') {
        return send(response, 200, { events: listSelfImproveEvents(db, user.tenantId, { limit: 200 }) });
      }
      // --- Transactional email outbox (admin) --------------------------------
      // Operators inspect queued/failed transactional mail and drain the queue
      // through the configured provider. Without a provider the process route
      // reports the fail-closed state and preserves queued rows.
      if (method === 'GET' && parts.join('/') === 'notifications/outbox') {
        requireRole(user, ['owner', 'admin']);
        const status = new URL(request.url, 'http://localhost').searchParams.get('status') || undefined;
        const providerConfigured = Boolean(process.env.EMAIL_PROVIDER && process.env.EMAIL_WEBHOOK_URL);
        return send(response, 200, { providerConfigured, emails: listOutbox(db, user.tenantId, { status }) });
      }
      if (method === 'POST' && parts.join('/') === 'notifications/outbox/process') {
        requireRole(user, ['owner', 'admin']);
        return send(response, 200, await processOutbox(db, { env: process.env }));
      }
      // ---- Durable chat state -------------------------------------------------
      if (method === 'GET' && parts.join('/') === 'conversations') {
        const limit = Number(new URL(request.url, 'http://localhost').searchParams.get('limit')) || 50;
        return send(response, 200, { conversations: chat.listConversations({ tenantId: user.tenantId, userId: user.id, limit }) });
      }
      if (method === 'POST' && parts.join('/') === 'conversations') {
        const input = await body(request);
        return send(response, 201, chat.createConversation({ tenantId: user.tenantId, userId: user.id, title: input.title, projectId: input.projectId ?? null, mode: input.mode ?? 'chat' }));
      }
      if (method === 'GET' && parts.join('/') === 'chat/recoverable') {
        return send(response, 200, { conversations: chat.listRecoverable({ tenantId: user.tenantId, userId: user.id }) });
      }
      if (parts[0] === 'conversations' && parts[1] && parts.length <= 3) {
        const conversationId = parts[1];
        if (method === 'GET' && parts.length === 2) return send(response, 200, chat.getConversation({ tenantId: user.tenantId, userId: user.id, conversationId }));
        if (method === 'PATCH' && parts.length === 2) { const input = await body(request); return send(response, 200, chat.renameConversation({ tenantId: user.tenantId, userId: user.id, conversationId, title: input.title })); }
        if (method === 'DELETE' && parts.length === 2) return send(response, 200, chat.deleteConversation({ tenantId: user.tenantId, userId: user.id, conversationId }));
        if (method === 'POST' && parts[2] === 'recover') return send(response, 200, { recovered: chat.recoverInterrupted({ tenantId: user.tenantId, userId: user.id, conversationId }) });
        if (method === 'POST' && parts[2] === 'messages') {
          const input = await body(request);
          const message = chat.appendMessage({ tenantId: user.tenantId, conversationId, userId: user.id, role: 'user', content: validateText(input.content, 'MESSAGE', 12000), status: 'complete' });
          return send(response, 201, message);
        }
      }
      if (method === 'POST' && parts.join('/') === 'chat/stream') {
        const input = await body(request);
        const message = validateText(input.message, 'MESSAGE', 12000);
        const model = normalizeModelId(input.model);
        if (typeof llm.stream !== 'function') throw new Error('STREAMING_NOT_SUPPORTED');
        // Quota is checked BEFORE any bytes are written so an over-quota tenant still
        // receives a clean JSON 402 from the outer error handler.
        consumeQuota(db, user.tenantId, {});
        // Resolve or create the conversation and persist the user turn BEFORE the
        // first byte, so a dropped connection never loses the user's message.
        const conversationId = input.conversationId
          ? chat.getConversation({ tenantId: user.tenantId, userId: user.id, conversationId: input.conversationId }).id
          : chat.createConversation({ tenantId: user.tenantId, userId: user.id, title: message.slice(0, 80), mode: 'chat' }).id;
        const userMessage = chat.appendMessage({ tenantId: user.tenantId, conversationId, userId: user.id, role: 'user', content: message, status: 'complete' });
        // The assistant row is created as `streaming` up front. If this process
        // dies mid-stream the row is left `streaming` and `recoverInterrupted`
        // sweeps it to `interrupted` for retry — no silent data loss.
        const assistantMessage = chat.appendMessage({ tenantId: user.tenantId, conversationId, role: 'assistant', content: '', status: 'streaming', model });
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        const writeFrame = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        writeFrame('start', { conversationId, userMessageId: userMessage.id, assistantMessageId: assistantMessage.id });
        let usage = null;
        let provider = null;
        let text = '';
        try {
          for await (const frame of llm.stream({ model, messages: [
            { role: 'system', content: 'You are the Semo0o assistant. Answer naturally and accurately. Do not execute tools, claim external actions, or provide a medical diagnosis. Reply in Arabic when the user writes Arabic.' },
            { role: 'user', content: message },
          ] })) {
            if (frame.type === 'token') { text += frame.text; writeFrame('token', { text: frame.text }); }
            else if (frame.type === 'done') { usage = frame.usage; provider = frame.provider; }
          }
          const streamTokens = Number(usage?.totalTokens) || 0;
          if (streamTokens > 0) consumeQuota(db, user.tenantId, { tokens: streamTokens });
          chat.updateMessage({ tenantId: user.tenantId, messageId: assistantMessage.id, patch: { content: text, status: 'complete', provider, usage } });
          db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'chat.stream.completed', 'chat', user.id, JSON.stringify({ conversationId, provider, model, usage, chars: text.length }), now());
          writeFrame('done', { conversationId, assistantMessageId: assistantMessage.id, provider, usage, chars: text.length });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          // Preserve the partial text and record the failure so the client can retry.
          chat.updateMessage({ tenantId: user.tenantId, messageId: assistantMessage.id, patch: { content: text, status: 'error', error: errorMessage } });
          writeFrame('error', { conversationId, assistantMessageId: assistantMessage.id, error: errorMessage });
        } finally {
          response.end();
        }
        return;
      }
      if (method === 'POST' && parts.join('/') === 'chat') {
        const input = await body(request);
        const message = validateText(input.message, 'MESSAGE', 12000);
        const model = normalizeModelId(input.model);
        consumeQuota(db, user.tenantId, {});
        const conversationId = input.conversationId
          ? chat.getConversation({ tenantId: user.tenantId, userId: user.id, conversationId: input.conversationId }).id
          : chat.createConversation({ tenantId: user.tenantId, userId: user.id, title: message.slice(0, 80), mode: 'chat' }).id;
        chat.appendMessage({ tenantId: user.tenantId, conversationId, userId: user.id, role: 'user', content: message, status: 'complete' });
        const result = await llm.complete({ model, messages: [
          { role: 'system', content: 'You are the Semo0o assistant. Answer naturally and accurately. Do not execute tools, claim external actions, or provide a medical diagnosis. Reply in Arabic when the user writes Arabic.' },
          { role: 'user', content: message },
        ] });
        const chatTokens = Number(result.usage?.totalTokens ?? result.usage?.total_tokens) || 0;
        if (chatTokens > 0) consumeQuota(db, user.tenantId, { tokens: chatTokens });
        const assistantMessage = chat.appendMessage({ tenantId: user.tenantId, conversationId, role: 'assistant', content: result.text ?? '', status: 'complete', provider: result.provider, model, usage: result.usage });
        db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'chat.completed', 'chat', user.id, JSON.stringify({ conversationId, provider: result.provider, model: model || null, usage: result.usage }), now());
        return send(response, 200, { conversationId, messageId: assistantMessage.id, text: result.text, provider: result.provider, usage: result.usage });
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
        if (method === 'POST' && parts.length === 3) { const input = await body(request); validateText(input.source || 'api', 'SOURCE', 200); validateText(input.content, 'CONTENT', 200000); return send(response, 201, await memory.addDocument({ tenantId: user.tenantId, projectId: project.id, source: input.source || 'api', content: input.content })); }
        if (method === 'GET' && parts.length === 3) return send(response, 200, await memory.search({ tenantId: user.tenantId, projectId: project.id, query: validateText(new URL(request.url, 'http://localhost').searchParams.get('q'), 'QUERY', 500), limit: 10 }));
        if (method === 'GET' && parts[3] === 'export') return send(response, 200, memory.exportProject(user.tenantId, project.id));
        if (method === 'POST' && parts[3] === 'reindex') return send(response, 200, await memory.reindexProject(user.tenantId, project.id));
        if (method === 'DELETE' && parts.length === 3) { requireRole(user, ['owner', 'admin']); return send(response, 200, { deleted: memory.deleteProject(user.tenantId, project.id).changes }); }
      }
      if (method === 'POST' && parts[0] === 'runs' && parts.length === 1) {
        const input = await body(request);
        const kind = typeof input.kind === 'string' ? input.kind : 'code.run';
        if (!['code.run', 'agent.run'].includes(kind)) throw new Error('UNSUPPORTED_RUN_KIND');
        // Preserve routing sentinels ("auto"/"default"/"test"/empty): they are a
        // request for the Phase E router to choose by task type, not a concrete
        // model. Only explicit, real model IDs are normalised/validated here.
        if (kind === 'agent.run' && input.model !== undefined && !isRoutingSentinel(input.model)) input.model = normalizeModelId(input.model);
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
      if (parts[0] === 'tasks' && parts[1] && parts[2] === 'git' && method === 'GET') {
        const action = parts[3] || 'status';
        if (!['status', 'diff', 'branch'].includes(action)) throw new Error('NOT_FOUND');
        return send(response, 200, await taskGitRead(db, user, parts[1], action));
      }
      if (method === 'POST' && parts[0] === 'tasks' && parts[1] && parts[2] === 'workspace' && parts.length === 3) {
        const input = await body(request);
        const task = db.get('SELECT * FROM tasks WHERE id=? AND tenant_id=?', parts[1], user.tenantId);
        if (!task) throw new Error('NOT_FOUND');
        const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', task.project_id, user.tenantId);
        assertProjectAccess(project, user);
        if (task.created_by !== user.id) requireRole(user, ['owner', 'admin']);
        const baseWorkspace = db.get('SELECT root_path FROM workspaces WHERE project_id=? ORDER BY created_at LIMIT 1', project.id);
        const baseRoot = typeof input.baseRoot === 'string'
          ? path.resolve(validateText(input.baseRoot, 'BASE_ROOT', 1024))
          : (baseWorkspace?.root_path || process.env.WORKSPACE_ROOT);
        if (!baseRoot) throw new Error('WORKSPACE_ROOT_REQUIRED');
        let handle;
        try {
          handle = await provisionTaskWorkspace({
            taskId: task.id,
            repo: typeof input.repo === 'string' ? input.repo : undefined,
            ref: typeof input.ref === 'string' ? input.ref : undefined,
            branch: typeof input.branch === 'string' ? input.branch : undefined,
            baseRoot,
            allowExisting: input.allowExisting === true,
          });
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : String(error?.message || 'WORKSPACE_PROVISION_FAILED');
          throw new Error(code.split(':')[0]);
        }
        const workspaceId = id('workspace');
        db.transaction(() => {
          db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, project.id, handle.workspacePath, now());
          db.run('UPDATE tasks SET workspace_id=?, updated_at=? WHERE id=?', workspaceId, now(), task.id);
          db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'task.workspace.provisioned', 'task', task.id, JSON.stringify({ workspaceId, branch: handle.branch, repo: handle.clone?.url ?? null }), now());
        });
        return send(response, 201, { taskId: task.id, workspaceId, workspacePath: handle.workspacePath, branch: handle.branch, branchCreated: handle.branchCreated, clone: handle.clone });
      }
      if (parts[0] === 'runs' && parts[1]) {
        const run = runQueue.get(parts[1], user.tenantId);
        if (!run) throw new Error('NOT_FOUND');
        const task = assertRunAccess(db, run, user);
        if (method === 'GET' && parts.length === 2) return send(response, 200, { ...run, payload: JSON.parse(run.payload_json), result: run.result_json ? JSON.parse(run.result_json) : null, evidence: db.all('SELECT id,kind,payload_json,sha256,created_at FROM evidence WHERE run_id=? ORDER BY created_at', run.id), events: db.all('SELECT id,type,payload_json,created_at FROM run_events WHERE run_id=? ORDER BY created_at', run.id), usage: db.all('SELECT provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd FROM run_usage WHERE run_id=?', run.id) });
        // Reusable evaluation & quality control: a reproducible scorecard for this
        // run (outcome, tool efficiency, cost/latency, evidence completeness,
        // human intervention, composite quality). Derived from the run's own rows.
        if (method === 'GET' && parts[2] === 'evaluation') {
          const evaluation = evaluateRun(db, run.id, { tenantId: user.tenantId });
          return send(response, 200, evaluation ?? { runId: run.id, status: run.status, evaluated: false });
        }
        // Regression hook: compare this run against a baseline run and flag a
        // quality regression beyond the (optional) threshold.
        if (method === 'GET' && parts[2] === 'compare') {
          const url = new URL(request.url, 'http://localhost');
          const baseline = validateText(url.searchParams.get('baseline'), 'RUN_ID', 128);
          const threshold = Number(url.searchParams.get('threshold'));
          const baselineRun = runQueue.get(baseline, user.tenantId);
          if (!baselineRun) throw new Error('NOT_FOUND');
          assertRunAccess(db, baselineRun, user);
          const comparison = compareRuns(db, baseline, run.id, { tenantId: user.tenantId, ...(Number.isFinite(threshold) ? { threshold } : {}) });
          return send(response, 200, comparison ?? { compared: false });
        }
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
      // --- Scheduled / recurring autonomy (Trigger Scheduler) ---------------
      // A trigger is a durable definition of WHEN to start a run. Firing a
      // trigger creates an ordinary task + queued run, so scheduled work is
      // processed by the same worker as everything else.
      if (parts[0] === 'triggers') {
        if (method === 'GET' && parts.length === 1) {
          const rows = db.all('SELECT * FROM scheduled_triggers WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200', user.tenantId);
          return send(response, 200, { triggers: rows.map(triggerView) });
        }
        if (method === 'POST' && parts.length === 1) {
          const input = await body(request);
          const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', input.projectId, user.tenantId);
          assertProjectAccess(project, user);
          const kind = validateText(input.kind || 'cron', 'TRIGGER_KIND', 16);
          if (!TRIGGER_KINDS.includes(kind)) throw new Error('TRIGGER_KIND_INVALID');
          const schedule = normalizeSchedule(kind, validateText(input.schedule, 'TRIGGER_SCHEDULE', 200));
          const name = validateText(input.name, 'TRIGGER_NAME', 200);
          const goal = validateText(input.goal, 'GOAL', 4000);
          const workspaceId = input.workspaceId ? validateText(input.workspaceId, 'WORKSPACE_ID', 128) : null;
          if (workspaceId && !db.get('SELECT id FROM workspaces WHERE id=? AND project_id=?', workspaceId, project.id)) throw new Error('NOT_FOUND');
          const payload = input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
          const enabled = input.enabled === false ? 0 : 1;
          const timezone = input.timezone ? validateText(input.timezone, 'TRIGGER_TIMEZONE', 64) : 'UTC';
          if (!isValidTimeZone(timezone)) throw new Error('INVALID_TRIGGER_TIMEZONE');
          const missedRunPolicy = input.missedRunPolicy ? validateText(input.missedRunPolicy, 'TRIGGER_MISSED_RUN_POLICY', 16) : 'catchup';
          if (!MISSED_RUN_POLICIES.includes(missedRunPolicy)) throw new Error('INVALID_TRIGGER_MISSED_RUN_POLICY');
          const triggerId = id('trigger');
          const timestamp = now();
          const next = enabled ? computeNextRun({ kind, schedule, created_at: timestamp, timezone }, new Date()) : null;
          db.transaction(() => {
            db.run(
              'INSERT INTO scheduled_triggers(id,tenant_id,project_id,workspace_id,created_by,name,kind,schedule,goal,payload_json,enabled,next_run_at,timezone,missed_run_policy,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
              triggerId, user.tenantId, project.id, workspaceId, user.id, name, kind, schedule, goal, JSON.stringify(payload), enabled, next ? next.toISOString() : null, timezone, missedRunPolicy, timestamp, timestamp,
            );
            db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), user.tenantId, 'trigger.created', 'scheduled_trigger', triggerId, JSON.stringify({ kind, schedule, timezone, missedRunPolicy }), timestamp);
          });
          return send(response, 201, triggerView(db.get('SELECT * FROM scheduled_triggers WHERE id=?', triggerId)));
        }
        if (parts[1]) {
          const trigger = db.get('SELECT * FROM scheduled_triggers WHERE id=? AND tenant_id=?', parts[1], user.tenantId);
          if (!trigger) throw new Error('NOT_FOUND');
          if (method === 'POST' && parts[2] === 'run') {
            return send(response, 202, scheduler.fire({ ...trigger, next_run_at: trigger.next_run_at || now() }));
          }
          if (method === 'PATCH' && parts.length === 2) {
            const input = await body(request);
            const fields = [];
            const params = [];
            if (input.name !== undefined) { fields.push('name=?'); params.push(validateText(input.name, 'TRIGGER_NAME', 200)); }
            if (input.goal !== undefined) { fields.push('goal=?'); params.push(validateText(input.goal, 'GOAL', 4000)); }
            const kind = input.kind !== undefined ? validateText(input.kind, 'TRIGGER_KIND', 16) : trigger.kind;
            const schedule = (input.schedule !== undefined || input.kind !== undefined)
              ? normalizeSchedule(kind, validateText(input.schedule ?? trigger.schedule, 'TRIGGER_SCHEDULE', 200))
              : trigger.schedule;
            if (input.kind !== undefined || input.schedule !== undefined) { fields.push('kind=?', 'schedule=?'); params.push(kind, schedule); }
            if (input.payload !== undefined && input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)) { fields.push('payload_json=?'); params.push(JSON.stringify(input.payload)); }
            const timezone = input.timezone !== undefined ? validateText(input.timezone, 'TRIGGER_TIMEZONE', 64) : (trigger.timezone || 'UTC');
            if (!isValidTimeZone(timezone)) throw new Error('INVALID_TRIGGER_TIMEZONE');
            if (input.timezone !== undefined) { fields.push('timezone=?'); params.push(timezone); }
            const missedRunPolicy = input.missedRunPolicy !== undefined ? validateText(input.missedRunPolicy, 'TRIGGER_MISSED_RUN_POLICY', 16) : (trigger.missed_run_policy || 'catchup');
            if (!MISSED_RUN_POLICIES.includes(missedRunPolicy)) throw new Error('INVALID_TRIGGER_MISSED_RUN_POLICY');
            if (input.missedRunPolicy !== undefined) { fields.push('missed_run_policy=?'); params.push(missedRunPolicy); }
            const enabled = input.enabled === undefined ? trigger.enabled : (input.enabled ? 1 : 0);
            if (input.enabled !== undefined) { fields.push('enabled=?'); params.push(enabled); }
            const next = enabled ? computeNextRun({ ...trigger, kind, schedule, timezone }, new Date()) : null;
            fields.push('next_run_at=?'); params.push(next ? next.toISOString() : null);
            // A changed schedule/timezone is a fresh start: clear backoff state.
            if (input.schedule !== undefined || input.kind !== undefined || input.timezone !== undefined) fields.push('retry_count=0');
            fields.push('updated_at=?'); params.push(now());
            params.push(trigger.id, user.tenantId);
            db.run(`UPDATE scheduled_triggers SET ${fields.join(',')} WHERE id=? AND tenant_id=?`, ...params);
            return send(response, 200, triggerView(db.get('SELECT * FROM scheduled_triggers WHERE id=?', trigger.id)));
          }
          if (method === 'DELETE' && parts.length === 2) {
            db.run('DELETE FROM scheduled_triggers WHERE id=? AND tenant_id=?', trigger.id, user.tenantId);
            return send(response, 200, { deleted: trigger.id });
          }
        }
      }
      // --- Cross-run reflection / episodic lessons --------------------------
      if (method === 'GET' && parts[0] === 'reflections') {
        const projectId = new URL(request.url, 'http://localhost').searchParams.get('projectId') || undefined;
        if (projectId) { const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', projectId, user.tenantId); assertProjectAccess(project, user); }
        return send(response, 200, { reflections: listReflections(db, user.tenantId, { projectId }) });
      }
      // --- Evaluation & quality control -------------------------------------
      // A windowed, reproducible scorecard across this tenant's terminal runs
      // (optionally scoped to a project). Built from the same durable rows the
      // observability endpoint reads — no second metrics system.
      if (method === 'GET' && parts.join('/') === 'evaluation/summary') {
        const url = new URL(request.url, 'http://localhost');
        const projectId = url.searchParams.get('projectId') || undefined;
        if (projectId) { const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', projectId, user.tenantId); assertProjectAccess(project, user); }
        const windowHours = Math.max(1, Math.min(24 * 90, Number(url.searchParams.get('windowHours')) || 168));
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 200));
        const summary = evaluateRuns(db, { tenantId: user.tenantId, projectId, windowHours, limit });
        // Keep the response bounded: the per-run detail is available on
        // GET /runs/:id/evaluation.
        return send(response, 200, { ...summary, runs: summary.runs.slice(0, 50) });
      }
      // --- Experience Engine (learned, outcome-driven priors) ---------------
      // The per-tenant scorecard derived from REAL runs: which model succeeds for
      // each task type, which tools are reliable, which RECOVERY action works for
      // each failure kind, which STRATEGY wins for each task type, and which tool
      // to prefer. This is the exact prior the Maestro loop consumes, exposed
      // read-only for operators. All priors are recency-weighted + Wilson-bounded.
      if (method === 'GET' && parts.join('/') === 'experience/summary') {
        const url = new URL(request.url, 'http://localhost');
        const windowHours = Math.max(1, Math.min(24 * 180, Number(url.searchParams.get('windowHours')) || 24 * 30));
        const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 500));
        const snapshot = buildExperienceSnapshot(db, { tenantId: user.tenantId, windowHours, limit });
        return send(response, 200, {
          ...summarizeExperience(snapshot),
          models: snapshot.models,
          tools: snapshot.tools,
          recovery: snapshot.recovery,
          strategies: snapshot.strategies,
          execution: snapshot.execution,
          derived: {
            recovery: recoveryPriorFromSnapshot(snapshot),
            strategies: strategyPriorFromSnapshot(snapshot),
            execution: executionPriorFromSnapshot(snapshot),
          },
        });
      }
      // --- Unified learning loop -------------------------------------------
      // One read-only view of the WHOLE closed loop for this tenant: the
      // EVALUATION scorecard, the EXPERIENCE snapshot summary, the open
      // SELF-IMPROVE proposals and the latest REFLECTIONS — i.e. all five
      // components (Experience + Evaluation + Reflection + Memory + Self-Improve)
      // side by side, so an operator can see what the system has actually learned
      // and whether it is improving. Pure reads; tenant-scoped; fail-soft.
      if (method === 'GET' && parts.join('/') === 'learning/summary') {
        const url = new URL(request.url, 'http://localhost');
        const projectId = url.searchParams.get('projectId') || undefined;
        if (projectId) { const project = db.get('SELECT * FROM projects WHERE id=? AND tenant_id=?', projectId, user.tenantId); assertProjectAccess(project, user); }
        const windowHours = Math.max(1, Math.min(24 * 90, Number(url.searchParams.get('windowHours')) || 168));
        return send(response, 200, learningSummary({ db, tenantId: user.tenantId, projectId, windowHours }));
      }
      // --- Production safety / degradation ----------------------------------
      // The active risk policy plus a live graceful-degradation report (which
      // providers/tools are unavailable right now). Read-only and tenant-scoped.
      if (method === 'GET' && parts.join('/') === 'safety/status') {
        const startup = validateStartupConfig(process.env);
        const degraded = degradedCapabilities({ tools, llm });
        return send(response, 200, {
          ok: true,
          riskPolicy: riskPolicy(),
          degraded: degraded.degraded,
          degradation: degraded,
          startup: { ok: startup.ok, production: startup.production, errors: startup.errors, warnings: startup.warnings },
        });
      }
      // --- Code intelligence ------------------------------------------------
      // Read-only views over the project index. They never mutate the workspace
      // and never fabricate data: an empty repository yields an empty (honest)
      // index rather than a fake result.
      if (method === 'GET' && parts.join('/') === 'codebase/intelligence') {
        const url = new URL(request.url, 'http://localhost');
        const projectId = validateText(url.searchParams.get('projectId'), 'PROJECT_ID', 128);
        const root = projectWorkspaceRoot(db, user, projectId);
        const maxFiles = Number(url.searchParams.get('maxFiles')) || undefined;
        const intelligence = await buildProjectIntelligence(root, maxFiles ? { maxFiles } : {});
        const summary = {
          generatedAt: intelligence.generatedAt, root: intelligence.root, parser: intelligence.parser, truncated: intelligence.truncated,
          counts: { files: intelligence.files.length, symbols: intelligence.symbols.length, imports: intelligence.imports.length, edges: intelligence.importGraph.length, tests: intelligence.testMapping.length },
        };
        if (url.searchParams.get('full') === '1') return send(response, 200, { ...summary, intelligence });
        return send(response, 200, {
          ...summary,
          sample: { files: intelligence.files.slice(0, 200), symbols: intelligence.symbols.slice(0, 50), edges: intelligence.importGraph.slice(0, 50) },
        });
      }
      if (method === 'POST' && parts.join('/') === 'codebase/impact') {
        const input = await body(request);
        const projectId = validateText(input.projectId, 'PROJECT_ID', 128);
        const root = projectWorkspaceRoot(db, user, projectId);
        const changedFiles = Array.isArray(input.changedFiles) ? input.changedFiles.filter((file) => typeof file === 'string') : [];
        if (!changedFiles.length) throw new Error('INVALID_CHANGED_FILES');
        const intelligence = await buildProjectIntelligence(root);
        const impact = analyzeImpact(intelligence, { changedFiles, maxDepth: input.maxDepth });
        return send(response, 200, { ...impact, description: describeImpact(impact) });
      }
      if (method === 'POST' && parts.join('/') === 'codebase/reason') {
        const input = await body(request);
        const projectId = validateText(input.projectId, 'PROJECT_ID', 128);
        const root = projectWorkspaceRoot(db, user, projectId);
        const question = validateText(input.question, 'QUESTION', 2000);
        const intelligence = await buildProjectIntelligence(root);
        const reasoner = new CodebaseReasoner(intelligence, { read: workspaceReader(root) });
        const mode = String(input.mode || 'auto');
        const target = input.target || question;
        if (mode === 'definition') return send(response, 200, reasoner.definition(target));
        if (mode === 'references') return send(response, 200, await reasoner.references(target));
        if (mode === 'trace') return send(response, 200, reasoner.trace(input.from, input.to));
        if (mode === 'explain') return send(response, 200, await reasoner.explain(target));
        if (mode === 'search') return send(response, 200, { results: reasoner.search(question) });
        return send(response, 200, await reasoner.answer(question));
      }
      if (method === 'POST' && parts.join('/') === 'codebase/changeset') {
        const input = await body(request);
        const projectId = validateText(input.projectId, 'PROJECT_ID', 128);
        const root = projectWorkspaceRoot(db, user, projectId);
        const intelligence = await buildProjectIntelligence(root);
        let status = [];
        let diff = '';
        try {
          const engine = await createExecutionEngine({
            workspacePath: root,
            evidenceDirectory: path.join(os.tmpdir(), 'semo0o-changeset', projectId),
            grants: [Capability.GIT_READ],
            limits: { timeoutMs: 30_000, maxOutputBytes: 2_000_000, memoryLimitMb: 2_048, cpuLimitSeconds: 30 },
          });
          status = (await engine.git.status()).entries ?? [];
          diff = (await engine.git.diff()).stdout ?? '';
        } catch { /* not a git repo / git unavailable -> honest empty change set */ }
        const changeSet = buildChangeSet({ status, diff, intelligence, goal: typeof input.goal === 'string' ? input.goal.slice(0, 2000) : undefined });
        return send(response, 200, { ...changeSet, description: describeChangeSet(changeSet) });
      }
      // --- Capability benchmarking -----------------------------------------
      if (method === 'GET' && parts.join('/') === 'capabilities/scorecard') {
        // Fold in the outcome of the last real E2E benchmarks (agent + browser)
        // so the endpoint reports `proven` only where evidence exists; a missing
        // report leaves the capability honestly `wired` (never a flag-only claim).
        const proof = loadProofArtifacts(process.cwd());
        const signals = collectCapabilitySignals({ tools, llm, integrations: integrationStatusView({ db, user, tools }), proof });
        const scorecard = buildCapabilityScorecard(signals);
        return send(response, 200, { ...scorecard, description: describeScorecard(scorecard) });
      }
      if (method === 'POST' && parts.join('/') === 'benchmark/agent') {
        const input = await body(request);
        const projectId = validateText(input.projectId, 'PROJECT_ID', 128);
        const root = projectWorkspaceRoot(db, user, projectId);
        const { report, workspace } = await runAgentBenchmark({ tools, root });
        return send(response, 200, { ...report, workspace });
      }
      throw new Error('NOT_FOUND');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = ['UNAUTHORIZED','INVALID_CREDENTIALS','MFA_REQUIRED','MFA_CODE_INVALID'].includes(message) ? 401 : ['FORBIDDEN','CORS_ORIGIN_DENIED','SELF_APPROVAL_FORBIDDEN'].includes(message) ? 403 : ['NOT_FOUND','BILLING_CUSTOMER_NOT_FOUND','BILLING_SUBSCRIPTION_NOT_FOUND','SELF_IMPROVE_PROPOSAL_NOT_FOUND','ORG_MEMBER_NOT_FOUND','ORG_INVITATION_NOT_FOUND','CONVERSATION_NOT_FOUND','CHAT_MESSAGE_NOT_FOUND','PROJECT_NOT_FOUND','ACCOUNT_NOT_FOUND','CREATION_JOB_NOT_FOUND','CREATION_ARTIFACT_NOT_FOUND'].includes(message) ? 404 : ['MONTHLY_TOKEN_QUOTA_EXCEEDED','MONTHLY_RUN_QUOTA_EXCEEDED'].includes(message) ? 402 : ['BILLING_PROVIDER_NOT_CONFIGURED','BILLING_PROVIDER_CREDENTIALS_REQUIRED','EMAIL_PROVIDER_NOT_CONFIGURED','GITHUB_OAUTH_NOT_CONFIGURED','GITHUB_NOT_CONFIGURED','GITHUB_TOKEN_REQUIRED','SENTRY_DSN_INVALID','SECRETS_MASTER_KEY_REQUIRED'].includes(message) ? 503 : ['BILLING_PROVIDER_UNSUPPORTED'].includes(message) ? 501 : ['ORG_LAST_OWNER_PROTECTED','ORG_OWNER_TRANSFER_REQUIRES_DEDICATED_FLOW','ORG_INVITATION_ALREADY_ACCEPTED','ORG_OWNER_TRANSFER_REQUIRED','ORG_TENANT_HAS_OTHER_MEMBERS','WORKSPACE_EXISTS'].includes(message) ? 409 : (message.startsWith('INVALID_') || message.startsWith('UNSUPPORTED_') || message.startsWith('DELETE_') || message.startsWith('AGENT_') || message.startsWith('SELF_IMPROVE_') || message.startsWith('ORG_') || message.startsWith('CHAT_') || ['INVALID_JSON','BODY_TOO_LARGE','WORKSPACE_ROOT_REQUIRED','WORKSPACE_PATH_OUTSIDE_ROOT','BASE_ROOT_REQUIRED','DEFAULT_BRANCH_FORBIDDEN','GIT_CLONE_FAILED','GIT_INIT_FAILED','GIT_BRANCH_FAILED','BILLING_WEBHOOK_INVALID','BILLING_WEBHOOK_SIGNATURE_INVALID','BILLING_PLAN_NOT_PURCHASABLE','BILLING_PRICE_NOT_CONFIGURED','STREAMING_NOT_SUPPORTED','GITHUB_OAUTH_STATE_INVALID','GITHUB_REPO_INVALID','GITHUB_ACTION_UNSUPPORTED','GITHUB_OAUTH_EXCHANGE_FAILED'].includes(message)) ? 400 : message === 'RATE_LIMITED' ? 429 : 500;
      if (status >= 500 && errorTracker) {
        // Fire-and-forget: reporting must never delay or break the response.
        Promise.resolve(errorTracker.captureException(error, { transaction: `${request.method} ${new URL(request.url, 'http://localhost').pathname}`, tags: { requestId } })).catch(() => {});
      }
      // 503 signals a missing server-side configuration (a safe, actionable code);
      // only genuine 500s are masked so internal details never leak.
      send(response, status, { error: status >= 500 && status !== 503 ? "INTERNAL_ERROR" : message });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 64;
  return { server, db, queue: runQueue, chat, scheduler, pluginsReady, tools };
}

if (process.argv[1]?.endsWith('backend/server.mjs')) {
  // Fill the two NON-SECRET storage paths (DATABASE_FILE / WORKSPACE_ROOT) with
  // container-appropriate defaults before validation, so the backend boots on a
  // host that does not set them. SECRETS_MASTER_KEY is never defaulted: the
  // production secret check below stays fully enforced.
  applyRuntimeDefaults();
  assertEnv();
  const db = new Database();
  const app = createApp({ db, liveTools: createLiveToolRegistry({ db, engineAvailable: true }) });
  if (process.env.DISABLE_WORKER !== '1') { app.queue.start(); app.scheduler.start(); }
  const port = Number(process.env.PORT || 8787);
  // Render (and every other container host) injects PORT and requires the process
  // to bind 0.0.0.0 so its router and port-scanner can reach it. resolveBindHost
  // FORCES 0.0.0.0 on Render (never 127.0.0.1/localhost) and whenever PORT is set;
  // only a plain local run keeps the loopback default.
  const host = resolveBindHost();
  const shutdown = () => { app.scheduler.stop(); app.queue.stop(); app.server.close(() => db.close()); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  app.server.listen(port, host, () => {
    console.log(`backend listening on ${host}:${port}`);
    console.log(`backend database: ${db.file}`);
  });
}
