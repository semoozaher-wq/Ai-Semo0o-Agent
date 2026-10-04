import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');

export class Database {
  constructor(filename = process.env.DATABASE_FILE ?? path.resolve('data/agent.sqlite')) {
    const directory = path.dirname(filename);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if ((statSync(directory).mode & 0o077) !== 0) {
      const error = new Error('DATABASE_DIRECTORY_NOT_PRIVATE');
      error.code = 'DATABASE_DIRECTORY_NOT_PRIVATE';
      throw error;
    }
    this.db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
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
