/**
 * Cloud database persistence (Supabase / Neon / any managed PostgreSQL).
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend's operational store is SQLite (`node:sqlite`), which is fast and
 * synchronous but lives on the container filesystem. On a host without a mounted
 * persistent disk (Render's Free plan, ephemeral CI runners, ...) that file is
 * WIPED on every redeploy, so all tenants, runs, chats and artifacts are lost.
 *
 * This module adds a DURABLE, provider-agnostic safety net on top of the SAME
 * SQLite file, without replacing it:
 *
 *   1. On boot, if the local SQLite file is empty (fresh container), the newest
 *      snapshot is pulled back from PostgreSQL and restored BEFORE the database is
 *      opened. A redeploy therefore resumes with the previous state.
 *   2. While running, a consistent snapshot (`VACUUM INTO`) is uploaded to
 *      PostgreSQL periodically and once more on graceful shutdown.
 *
 * DESIGN CONSTRAINTS (deliberate):
 *   - BOTH options stay compatible: local SQLite keeps working exactly as before
 *     when `DATABASE_URL` is unset; cloud persistence is purely additive.
 *   - The PostgreSQL driver (`pg`) is loaded DYNAMICALLY. If it is not installed,
 *     or `DATABASE_URL` is missing, or the network is down, the module degrades to
 *     a NO-OP and the backend still boots on local SQLite. Cloud storage must
 *     never be a single point of failure.
 *   - The driver is INJECTABLE so the whole layer is unit-testable without a live
 *     PostgreSQL server (see backend/test/cloud-persistence.test.mjs).
 *   - Connection strings are never logged verbatim: `redactDatabaseUrl()` masks
 *     the password before any value reaches a logger.
 */
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase, restoreDatabase, verifyDatabase } from '../ops/sqlite-archive.mjs';

// Table that stores the opaque SQLite snapshots. It is created on demand and is
// the ONLY object this module touches in the cloud database, so it can share a
// PostgreSQL instance with other applications without collisions.
const SNAPSHOT_TABLE = 'db_snapshots';

// How often a running process uploads a fresh snapshot. Five minutes keeps the
// worst-case data loss window small while staying well inside the free-tier write
// budgets of Supabase/Neon.
export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// How many historical snapshots to retain in the cloud (older ones are pruned).
export const DEFAULT_SNAPSHOT_RETENTION = 5;

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

function fail(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

/**
 * Parse and validate a PostgreSQL connection string. Returns the connection
 * facts plus a redacted form safe for logs. Throws a classified error
 * (`CLOUD_DB_URL_MISSING` / `CLOUD_DB_URL_INVALID` /
 * `CLOUD_DB_URL_UNSUPPORTED_PROTOCOL`) so callers can fail closed on a typo
 * instead of silently disabling persistence.
 */
export function parseDatabaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw fail('CLOUD_DB_URL_MISSING');
  let url;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw fail('CLOUD_DB_URL_INVALID', cause);
  }
  const protocol = url.protocol.replace(/:$/, '').toLowerCase();
  if (protocol !== 'postgres' && protocol !== 'postgresql') throw fail('CLOUD_DB_URL_UNSUPPORTED_PROTOCOL');
  const host = url.hostname;
  const sslmode = (url.searchParams.get('sslmode') || '').toLowerCase();
  // Managed providers (Supabase/Neon) require TLS; a local socket does not. An
  // explicit `sslmode` always wins so an operator can opt in/out deliberately.
  const ssl = sslmode ? !['disable', 'allow'].includes(sslmode) : !LOCAL_HOSTNAMES.has(host);
  return {
    protocol,
    host,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '',
    user: url.username ? decodeURIComponent(url.username) : '',
    ssl,
    redacted: redactDatabaseUrl(raw),
  };
}

/**
 * Mask the password (and any password-like query parameter) in a connection
 * string. Never throws: an unparseable value collapses to a fixed placeholder so
 * a malformed secret can never be echoed by accident.
 */
export function redactDatabaseUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '<invalid-database-url>';
  }
  if (url.password) url.password = '***';
  for (const key of ['password', 'pass', 'pwd', 'sslpassword']) {
    if (url.searchParams.has(key)) url.searchParams.set(key, '***');
  }
  return url.toString();
}

/**
 * Load the default PostgreSQL driver (`pg`) dynamically. Returns `null` (and
 * warns) when the optional dependency is absent, so callers degrade gracefully.
 */
export async function loadDefaultDriver(logger = console) {
  try {
    const mod = await import('pg');
    return mod.default ?? mod;
  } catch (error) {
    logger.warn?.(
      'cloud-db: PostgreSQL driver "pg" could not be loaded '
        + `(${error?.code ?? error?.message ?? 'unknown error'}); cloud persistence is disabled `
        + '(local SQLite is unaffected). Install it with `npm install pg` to enable durable cloud snapshots.',
    );
    return null;
  }
}

/**
 * Build a snapshot store backed by PostgreSQL.
 *
 * The returned object implements a small, driver-agnostic contract so the rest of
 * the module (and the tests) never depend on `pg` directly:
 *   ensureSchema() -> Promise<void>
 *   readLatest()   -> Promise<{ id, createdAt, sha256, schemaVersion, bytes, content } | null>
 *   write(entry)   -> Promise<{ id, createdAt }>
 *   prune(keep)    -> Promise<number>
 *   close()        -> Promise<void>
 *
 * `driver` must expose a `Pool` constructor (the shape of `pg`). Passing no driver
 * is a programming error and throws `CLOUD_DB_DRIVER_REQUIRED`.
 */
export function createPostgresSnapshotStore({ connectionString, driver, logger = console } = {}) {
  const config = parseDatabaseUrl(connectionString);
  if (!driver || typeof driver.Pool !== 'function') throw fail('CLOUD_DB_DRIVER_REQUIRED');
  let pool = null;

  function getPool() {
    if (!pool) {
      pool = new driver.Pool({
        connectionString,
        ssl: config.ssl ? { rejectUnauthorized: false } : false,
        max: 2,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
      });
    }
    return pool;
  }

  return {
    config,
    table: SNAPSHOT_TABLE,
    async ensureSchema() {
      await getPool().query(
        `CREATE TABLE IF NOT EXISTS ${SNAPSHOT_TABLE} (`
          + 'id TEXT PRIMARY KEY, created_at TEXT NOT NULL, sha256 TEXT NOT NULL, '
          + 'schema_version INTEGER NOT NULL, bytes BIGINT NOT NULL, label TEXT, content BYTEA NOT NULL)',
      );
      await getPool().query(`CREATE INDEX IF NOT EXISTS idx_${SNAPSHOT_TABLE}_created ON ${SNAPSHOT_TABLE}(created_at DESC)`);
    },
    async readLatest() {
      const { rows } = await getPool().query(
        `SELECT id, created_at, sha256, schema_version, bytes, label, content FROM ${SNAPSHOT_TABLE} `
          + 'ORDER BY created_at DESC, id DESC LIMIT 1',
      );
      if (!rows || rows.length === 0) return null;
      const row = rows[0];
      return {
        id: row.id,
        createdAt: row.created_at,
        sha256: row.sha256,
        schemaVersion: Number(row.schema_version),
        bytes: Number(row.bytes),
        label: row.label ?? null,
        content: Buffer.isBuffer(row.content) ? row.content : Buffer.from(row.content),
      };
    },
    async write({ content, sha256, schemaVersion, bytes, label = null, createdAt = new Date().toISOString() }) {
      const id = `snap_${String(sha256).slice(0, 16)}_${Date.now()}`;
      await getPool().query(
        `INSERT INTO ${SNAPSHOT_TABLE}(id, created_at, sha256, schema_version, bytes, label, content) `
          + 'VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING',
        [id, createdAt, sha256, schemaVersion, bytes, label, content],
      );
      return { id, createdAt };
    },
    async prune(keep = DEFAULT_SNAPSHOT_RETENTION) {
      const limit = Math.max(1, Number(keep) || 1);
      const { rowCount } = await getPool().query(
        `DELETE FROM ${SNAPSHOT_TABLE} WHERE id NOT IN `
          + `(SELECT id FROM ${SNAPSHOT_TABLE} ORDER BY created_at DESC, id DESC LIMIT $1)`,
        [limit],
      );
      return rowCount ?? 0;
    },
    async close() {
      if (!pool) return;
      const current = pool;
      pool = null;
      await current.end();
    },
    logger,
  };
}

// Create a private temp directory for a single snapshot operation and always
// clean it up, so a failed sync can never leave a stray database copy on disk.
async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-cloud-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A local SQLite file is considered "empty" when it is absent, unreadable, has no
// `tenants` table, or holds zero tenants. That is exactly the state of a fresh
// container after a redeploy.
export function isLocalDatabaseEmpty(databaseFile) {
  if (!existsSync(databaseFile)) return true;
  let probe;
  try {
    probe = new DatabaseSync(databaseFile, { readOnly: true });
    const row = probe.prepare('SELECT COUNT(*) AS count FROM tenants').get();
    return !row || Number(row.count) === 0;
  } catch {
    return true;
  } finally {
    try { probe?.close(); } catch { /* already closed */ }
  }
}

/**
 * Take a consistent snapshot of `databaseFile` (`VACUUM INTO`) and upload it to
 * the cloud store. Returns `{ uploaded: false, reason: 'UNCHANGED' }` when the
 * snapshot is byte-identical to the newest cloud copy, so an idle process does
 * not spam the provider with duplicate rows.
 */
export async function syncSnapshotToCloud({
  databaseFile,
  store,
  logger = console,
  keep = DEFAULT_SNAPSHOT_RETENTION,
  force = false,
} = {}) {
  if (!store) return { uploaded: false, reason: 'NO_STORE' };
  if (!existsSync(databaseFile)) return { uploaded: false, reason: 'NO_LOCAL_DATABASE' };
  await store.ensureSchema();
  const latest = await store.readLatest();
  return withTempDir(async (dir) => {
    const destination = path.join(dir, 'snapshot.sqlite');
    const archive = await backupDatabase(databaseFile, destination);
    if (!force && latest && latest.sha256 === archive.sha256) {
      return { uploaded: false, reason: 'UNCHANGED', sha256: archive.sha256 };
    }
    const content = await readFile(destination);
    const written = await store.write({
      content,
      sha256: archive.sha256,
      schemaVersion: archive.schemaVersion ?? 0,
      bytes: archive.bytes ?? content.length,
      label: path.basename(databaseFile),
    });
    const pruned = await store.prune(keep);
    logger.info?.(`cloud-db: uploaded snapshot ${written.id} (${archive.bytes} bytes, sha256 ${String(archive.sha256).slice(0, 12)}), pruned ${pruned} old snapshot(s)`);
    return {
      uploaded: true,
      id: written.id,
      sha256: archive.sha256,
      bytes: archive.bytes,
      schemaVersion: archive.schemaVersion ?? 0,
      createdAt: written.createdAt,
      pruned,
    };
  });
}

/**
 * Restore the newest cloud snapshot into `databaseFile` when the local database
 * is empty. MUST run before the database is opened (the restore replaces the
 * file). Returns a classified result instead of throwing so a boot-time restore
 * failure degrades to "start fresh" rather than taking the process down.
 */
export async function restoreFromCloudIfEmpty({
  databaseFile,
  store,
  logger = console,
  isEmpty = isLocalDatabaseEmpty,
} = {}) {
  if (!store) return { restored: false, reason: 'NO_STORE' };
  await store.ensureSchema();
  if (!isEmpty(databaseFile)) return { restored: false, reason: 'LOCAL_NOT_EMPTY' };
  const latest = await store.readLatest();
  if (!latest) return { restored: false, reason: 'NO_SNAPSHOT' };
  return withTempDir(async (dir) => {
    const snapshotPath = path.join(dir, 'restore.sqlite');
    writeFileSync(snapshotPath, latest.content, { mode: 0o600 });
    const verification = await verifyDatabase(snapshotPath);
    if (verification.sha256 !== latest.sha256) throw fail('CLOUD_SNAPSHOT_CHECKSUM_MISMATCH');
    // `restoreDatabase` never overwrites, so clear the empty local file (and any
    // stale WAL/SHM sidecars) first. This is safe: we only reach here when the
    // database is empty and nothing has it open yet.
    for (const suffix of ['', '-wal', '-shm']) await rm(`${databaseFile}${suffix}`, { force: true });
    const restored = await restoreDatabase(snapshotPath, databaseFile);
    logger.info?.(`cloud-db: restored snapshot ${latest.id} (schema v${restored.schemaVersion}) into ${databaseFile}`);
    return { restored: true, id: latest.id, sha256: latest.sha256, schemaVersion: restored.schemaVersion, bytes: restored.bytes };
  });
}

/**
 * Resolve the cloud store from the environment (or return a classified reason for
 * being disabled). Kept separate from `startCloudPersistence` so boot code can
 * log the outcome before deciding whether to open the database.
 */
export async function resolveCloudStore({
  env = process.env,
  driver,
  loadDriver = loadDefaultDriver,
  logger = console,
} = {}) {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) return { store: null, reason: 'NO_DATABASE_URL' };
  let config;
  try {
    config = parseDatabaseUrl(connectionString);
  } catch (error) {
    return { store: null, reason: error.code ?? 'CLOUD_DB_URL_INVALID' };
  }
  const resolvedDriver = driver ?? (await loadDriver(logger));
  if (!resolvedDriver) return { store: null, reason: 'NO_DRIVER', config };
  return { store: createPostgresSnapshotStore({ connectionString, driver: resolvedDriver, logger }), reason: 'ENABLED', config };
}

/**
 * Boot-time entry point. Restores from the cloud when the local database is empty
 * (BEFORE the caller opens it), then returns a controller that periodically
 * uploads snapshots and flushes once more on `stop()`.
 *
 * The controller is ALWAYS safe to use: when cloud persistence is disabled every
 * method is a no-op, so callers never need to branch.
 */
export async function startCloudPersistence({
  env = process.env,
  databaseFile,
  driver,
  loadDriver = loadDefaultDriver,
  logger = console,
  syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
  keep = DEFAULT_SNAPSHOT_RETENTION,
  restoreIfEmpty = true,
} = {}) {
  const disabled = (reason) => ({
    enabled: false,
    reason,
    store: null,
    config: null,
    restore: { restored: false, reason: 'DISABLED' },
    syncNow: async () => ({ uploaded: false, reason: 'DISABLED' }),
    stop: async () => ({ uploaded: false, reason: 'DISABLED' }),
  });

  const { store, reason, config } = await resolveCloudStore({ env, driver, loadDriver, logger });
  if (!store) {
    if (reason === 'NO_DATABASE_URL') logger.info?.('cloud-db: DATABASE_URL not set; using local SQLite only.');
    else logger.warn?.(`cloud-db: disabled (${reason}); using local SQLite only.`);
    return disabled(reason);
  }

  let restore = { restored: false, reason: 'SKIPPED' };
  if (restoreIfEmpty && databaseFile) {
    try {
      restore = await restoreFromCloudIfEmpty({ databaseFile, store, logger });
    } catch (error) {
      logger.error?.(`cloud-db: restore skipped (${error?.code ?? error?.message}); starting from the local database.`);
      restore = { restored: false, reason: error?.code ?? 'RESTORE_FAILED' };
    }
  }

  let timer = null;
  let stopped = false;
  const syncNow = async () => {
    if (stopped) return { uploaded: false, reason: 'STOPPED' };
    try {
      return await syncSnapshotToCloud({ databaseFile, store, logger, keep });
    } catch (error) {
      logger.error?.(`cloud-db: snapshot sync failed (${error?.code ?? error?.message}); will retry on the next interval.`);
      return { uploaded: false, reason: error?.code ?? 'SYNC_FAILED' };
    }
  };

  if (syncIntervalMs > 0) {
    timer = setInterval(() => { syncNow().catch(() => {}); }, syncIntervalMs);
    // Never keep the event loop alive just for the sync timer.
    timer.unref?.();
  }

  logger.info?.(`cloud-db: enabled for ${config?.redacted ?? 'configured database'}; snapshot every ${syncIntervalMs > 0 ? `${Math.round(syncIntervalMs / 1000)}s` : 'disabled (manual)'}, keeping ${keep}.`);

  return {
    enabled: true,
    reason: 'ENABLED',
    store,
    config,
    restore,
    syncNow,
    async stop({ finalSync = true } = {}) {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
      let result = { uploaded: false, reason: 'STOPPED' };
      if (finalSync) {
        try {
          result = await syncSnapshotToCloud({ databaseFile, store, logger, keep });
        } catch (error) {
          logger.error?.(`cloud-db: final snapshot failed (${error?.code ?? error?.message}).`);
          result = { uploaded: false, reason: error?.code ?? 'SYNC_FAILED' };
        }
      }
      await store.close().catch(() => {});
      return result;
    },
  };
}

export { SNAPSHOT_TABLE };
