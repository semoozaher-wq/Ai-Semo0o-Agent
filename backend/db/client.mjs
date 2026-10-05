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
      'ALTER TABLE users ADD COLUMN email_verified_at TEXT',
      'ALTER TABLE users ADD COLUMN mfa_secret TEXT',
      'ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0',
    ]) {
      try { this.db.exec(statement); } catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_tenant_idempotency ON runs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS rate_limit_buckets (bucket_key TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, PRIMARY KEY (bucket_key, bucket)); CREATE INDEX IF NOT EXISTS idx_rate_limit_expiry ON rate_limit_buckets(expires_at)');
    this.db.exec('CREATE TABLE IF NOT EXISTS tenant_members (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'active\', created_at TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS account_tokens (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS usage_quotas (tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE, monthly_tokens INTEGER NOT NULL DEFAULT 100000, monthly_runs INTEGER NOT NULL DEFAULT 1000, updated_at TEXT NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS usage_counters (tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, period TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, period))');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_members_user ON tenant_members(user_id, status); CREATE INDEX IF NOT EXISTS idx_invitations_tenant_email ON invitations(tenant_id, email, accepted_at); CREATE INDEX IF NOT EXISTS idx_account_tokens_lookup ON account_tokens(token_hash, kind, used_at)');
    const tenants = this.db.prepare('SELECT id FROM tenants').all();
    for (const tenant of tenants) {
      this.db.prepare('INSERT OR IGNORE INTO usage_quotas(tenant_id,updated_at) VALUES(?,?)').run(tenant.id, now());
      this.db.prepare('INSERT OR IGNORE INTO tenant_members(tenant_id,user_id,role,status,created_at) SELECT tenant_id,id,role,\'active\',created_at FROM users WHERE tenant_id=?').run(tenant.id);
    }
    this.db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(now());
  }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params) ?? null; }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(this); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

export { now, id, hash };
