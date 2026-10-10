import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync, statSync, accessSync, existsSync, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');

const DB_BASENAME = 'agent.sqlite';

// The SQLite file must live in a directory that is BOTH writable by the current
// process AND private (mode 0700). On hosts without a mounted persistent disk
// (for example Render's Free plan) a configured path such as
// `/var/data/db/agent.sqlite` is NOT writable, and blindly `mkdir`-ing it crashed
// the process at boot with `EACCES: permission denied, mkdir '/var/data/db'`.
// The helpers below make path resolution defensive: we never attempt to create a
// directory whose nearest existing ancestor is not writable, and we fall back to a
// safe writable location instead of crashing.

// Walk up from `target` until we find a directory that actually exists.
function nearestExistingAncestor(target) {
  let dir = path.resolve(target);
  for (;;) {
    if (existsSync(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

function isWritableDirectory(dir) {
  try { accessSync(dir, fsConstants.W_OK); return statSync(dir).isDirectory(); } catch { return false; }
}

// Create the directory if needed and enforce the 0700 privacy guarantee that the
// rest of the app (tenant/project isolation, secret storage) relies on. A newly
// created directory is always 0700 (mkdir's mode is not widened by a typical
// umask); a directory that already exists is validated but never silently
// re-permissioned, so an operator who loosened it still gets a hard failure.
function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if ((statSync(directory).mode & 0o077) !== 0) {
    const error = new Error('DATABASE_DIRECTORY_NOT_PRIVATE');
    error.code = 'DATABASE_DIRECTORY_NOT_PRIVATE';
    throw error;
  }
}

// Ordered list of candidate database files.
//   1. DATABASE_FILE  — the primary, operator-controlled path (absolute in prod).
//      Kept first so an existing persistent disk keeps working unchanged.
//   2. DATABASE_DIR   — optional convenience for hosts that only expose a writable
//      directory rather than a full file path.
//   3. ./backend/data — project-relative, already git-ignored; writable on Render
//      Free (the repo checkout is writable even without a disk).
//   4. os.tmpdir()    — last-resort location that is always writable, so the
//      process can still boot (e.g. read-only container root).
export function databaseFileCandidates(env = process.env) {
  const candidates = [];
  if (env.DATABASE_FILE) candidates.push(env.DATABASE_FILE);
  if (env.DATABASE_DIR) candidates.push(path.join(env.DATABASE_DIR, DB_BASENAME));
  candidates.push(path.resolve('backend', 'data', DB_BASENAME));
  candidates.push(path.join(os.tmpdir(), 'semo0o', DB_BASENAME));
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

// Resolve the first candidate whose directory can be created and made private.
// This never throws EACCES: unusable candidates are skipped, and the caller only
// sees a classified DATABASE_FILE_UNWRITABLE error if every candidate fails.
export function resolveDatabaseFile(env = process.env, { logger = console } = {}) {
  const attempts = [];
  const configured = env.DATABASE_FILE ? path.resolve(env.DATABASE_FILE) : null;
  for (const file of databaseFileCandidates(env)) {
    const directory = path.dirname(file);
    const ancestor = nearestExistingAncestor(directory);
    if (!isWritableDirectory(ancestor)) {
      attempts.push(`${file} (not writable: ${ancestor})`);
      continue;
    }
    try {
      ensurePrivateDirectory(directory);
    } catch (error) {
      attempts.push(`${file} (${error.code || error.message})`);
      continue;
    }
    if (configured && file !== configured) {
      logger.warn?.(`db: configured DATABASE_FILE '${configured}' is not writable; falling back to '${file}'`);
    }
    return file;
  }
  const error = new Error(`DATABASE_FILE_UNWRITABLE:${attempts.join(' | ')}`);
  error.code = 'DATABASE_FILE_UNWRITABLE';
  error.attempts = attempts;
  throw error;
}

export class Database {
  constructor(filename = resolveDatabaseFile()) {
    this.file = path.resolve(filename);
    ensurePrivateDirectory(path.dirname(this.file));
    this.db = new DatabaseSync(this.file);
    try { chmodSync(this.file, 0o600); }
    catch (cause) {
      this.db.close();
      const error = new Error('DATABASE_FILE_NOT_PRIVATE');
      error.code = 'DATABASE_FILE_NOT_PRIVATE';
      error.cause = cause;
      throw error;
    }
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }
  migrate() {
    const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    this.db.exec(schema);
    for (const statement of [
      'ALTER TABLE runs ADD COLUMN worker_id TEXT',
      'ALTER TABLE runs ADD COLUMN lease_until TEXT',
      'ALTER TABLE runs ADD COLUMN idempotency_key TEXT',
      // Queue reliability: a retried run is parked until `next_attempt_at` so a
      // persistently failing handler cannot hot-loop the worker (bounded backoff).
      'ALTER TABLE runs ADD COLUMN next_attempt_at TEXT',
      'ALTER TABLE users ADD COLUMN email_verified_at TEXT',
      'ALTER TABLE users ADD COLUMN mfa_secret TEXT',
      'ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0',
      // Artifact ledger enrichment (backend/artifacts/store.mjs): the table
      // previously only tracked path/hash/size, so a run could not tell an image
      // from a spreadsheet or carry any provenance metadata.
      'ALTER TABLE artifacts ADD COLUMN kind TEXT',
      'ALTER TABLE artifacts ADD COLUMN mime_type TEXT',
      'ALTER TABLE artifacts ADD COLUMN meta_json TEXT',
      'ALTER TABLE artifacts ADD COLUMN updated_at TEXT',
      // Scheduler hardening (backend/queue/scheduler.mjs): timezone-aware cron,
      // missed-run policy and bounded retry/backoff state per trigger.
      'ALTER TABLE scheduled_triggers ADD COLUMN timezone TEXT',
      'ALTER TABLE scheduled_triggers ADD COLUMN missed_run_policy TEXT',
      'ALTER TABLE scheduled_triggers ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE scheduled_triggers ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3',
      // Learning loop (backend/agent/reflection.mjs + backend/agent/learning-loop.mjs):
      // a reflection now carries the GRADED evaluation of the run it reflects on,
      // so Experience + Evaluation + Reflection share one outcome scale.
      'ALTER TABLE agent_reflections ADD COLUMN quality_score REAL',
      'ALTER TABLE agent_reflections ADD COLUMN reward REAL',
      // Spending limits (commercial readiness): a hard monthly USD cap per tenant
      // plus the accumulated spend for the period. Additive + idempotent so an
      // existing database picks up the new columns without a rebuild.
      'ALTER TABLE usage_quotas ADD COLUMN monthly_cost_usd REAL NOT NULL DEFAULT 10',
      'ALTER TABLE usage_counters ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0',
    ]) {
      try { this.db.exec(statement); } catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_tenant_idempotency ON runs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS rate_limit_buckets (bucket_key TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, PRIMARY KEY (bucket_key, bucket)); CREATE INDEX IF NOT EXISTS idx_rate_limit_expiry ON rate_limit_buckets(expires_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS tenant_members (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'active\', created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS account_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS usage_quotas (tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, monthly_tokens INTEGER NOT NULL DEFAULT 100000, monthly_runs INTEGER NOT NULL DEFAULT 1000, monthly_cost_usd REAL NOT NULL DEFAULT 10, updated_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS usage_counters (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, period TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, period))');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_members_user ON tenant_members(user_id, status); CREATE INDEX IF NOT EXISTS idx_invitations_tenant_email ON invitations(tenant_id, email, accepted_at); CREATE INDEX IF NOT EXISTS idx_account_tokens_lookup ON account_tokens(token_hash, kind, used_at)');
    // Functional indexes for case-insensitive lookups (auth + outbox export) that
    // would otherwise full-scan; idempotent so existing databases pick them up.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email)); CREATE INDEX IF NOT EXISTS idx_email_outbox_recipient ON email_outbox(tenant_id, lower(to_email), created_at)');
    // Artifact ledger lookups (per run and per path) — additive, idempotent.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id, created_at); CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(run_id, path)');
    // Per-run evaluation lookups (backend/agent/evaluation.mjs): scoring a run
    // reads its tool calls, usage and verification evidence by run id, so index
    // those paths — additive, idempotent.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, created_at); CREATE INDEX IF NOT EXISTS idx_run_usage_run ON run_usage(run_id); CREATE INDEX IF NOT EXISTS idx_evidence_run_kind ON evidence(run_id, kind)');
    const tenants = this.db.prepare('SELECT id FROM tenants').all();
    for (const tenant of tenants) {
      this.db.prepare('INSERT OR IGNORE INTO usage_quotas(tenant_id,updated_at) VALUES(?,?)').run(tenant.id, now());
      this.db.prepare('INSERT OR IGNORE INTO tenant_members(tenant_id,user_id,role,status,created_at) SELECT tenant_id,id,role,\'active\',created_at FROM users WHERE tenant_id=?').run(tenant.id);
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(now());
  }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  // `node:sqlite` first shipped in Node 22.5.0 and, in that release only,
  // `StatementSync.get()` returned a *phantom* all-null row object
  // (e.g. `{ id: null, tenant_id: null, ... }`) when NO row matched instead of
  // `undefined` (fixed in later 22.x). That silently turned every "does this row
  // exist?" probe into a false positive — breaking idempotency, session
  // revocation and billing. Reading the first row of `all()` (which returns `[]`
  // on every version) keeps the single-row `get()` contract correct on the whole
  // supported Node range.
  get(sql, ...params) {
    const rows = this.db.prepare(sql).all(...params);
    return rows.length > 0 ? rows[0] : null;
  }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  // Re-entrant transaction helper. A top-level call takes the write lock eagerly
  // with BEGIN IMMEDIATE (exactly as before). A *nested* call — e.g. the Trigger
  // Scheduler wrapping the RunQueue's own `enqueue` — uses a SAVEPOINT instead of
  // issuing a second BEGIN, which SQLite forbids ("cannot start a transaction
  // within a transaction"). This makes composable, atomic multi-step operations
  // safe across the whole platform without changing single-level behaviour.
  transaction(fn) {
    const depth = this._txDepth || 0;
    if (depth > 0) {
      const savepoint = `semo_sp_${depth}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this._txDepth = depth + 1;
      try {
        const value = fn(this);
        this.db.exec(`RELEASE ${savepoint}`);
        return value;
      } catch (error) {
        try { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); }
        catch { /* preserve the original error */ }
        throw error;
      } finally {
        this._txDepth = depth;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this._txDepth = 1;
    try {
      const value = fn(this);
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this._txDepth = 0;
    }
  }
  close() { this.db.close(); }
}

export { now, id, hash };
