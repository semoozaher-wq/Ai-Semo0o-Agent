import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, chmodSync, lstatSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');

export class Database {
  constructor(filename = process.env.DATABASE_FILE ?? path.resolve('.data/agent.sqlite')) {
    const databasePath = path.resolve(filename);
    const databaseDirectory = path.dirname(databasePath);
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    if ((statSync(databaseDirectory).mode & 0o077) !== 0) throw new Error('DATABASE_DIRECTORY_NOT_PRIVATE');
    try {
      const existing = lstatSync(databasePath);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('DATABASE_FILE_MUST_BE_REGULAR_FILE');
      chmodSync(databasePath, 0o600);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
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
    ]) {
      try { this.db.exec(statement); } catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_tenant_idempotency ON runs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
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
