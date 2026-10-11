import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, id, now } from '../db/client.mjs';
import {
  DEFAULT_SNAPSHOT_RETENTION,
  createPostgresSnapshotStore,
  isLocalDatabaseEmpty,
  loadDefaultDriver,
  parseDatabaseUrl,
  redactDatabaseUrl,
  resolveCloudStore,
  restoreFromCloudIfEmpty,
  startCloudPersistence,
  syncSnapshotToCloud,
} from '../db/cloud-persistence.mjs';

// -----------------------------------------------------------------------------
// A tiny in-memory stand-in for `pg`. It implements just enough of the `Pool`
// surface (query/end) that `createPostgresSnapshotStore` uses, and keeps the
// `db_snapshots` rows in a Map shared across instances so a test can simulate a
// full redeploy: write with one store, then read back with a brand-new store
// pointed at the same "server".
// -----------------------------------------------------------------------------
function createFakePostgres() {
  const servers = new Map(); // connectionString -> rows[]
  const log = [];
  class Pool {
    constructor(config) {
      this.config = config;
      this.key = config.connectionString;
      if (!servers.has(this.key)) servers.set(this.key, []);
      this.closed = false;
    }
    get rows() { return servers.get(this.key); }
    async query(text, params = []) {
      log.push({ text, params });
      if (/CREATE TABLE|CREATE INDEX/i.test(text)) return { rows: [], rowCount: 0 };
      if (/SELECT .* FROM db_snapshots/i.test(text)) {
        const sorted = [...this.rows].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : -1));
        return { rows: sorted.slice(0, 1), rowCount: Math.min(1, sorted.length) };
      }
      if (/INSERT INTO db_snapshots/i.test(text)) {
        const [id_, created_at, sha256, schema_version, bytes, label, content] = params;
        this.rows.push({ id: id_, created_at, sha256, schema_version, bytes, label, content });
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM db_snapshots/i.test(text)) {
        const keep = Number(params[0]) || 1;
        const sorted = [...this.rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        const kept = sorted.slice(0, keep);
        const removed = this.rows.length - kept.length;
        servers.set(this.key, kept);
        return { rows: [], rowCount: removed };
      }
      return { rows: [], rowCount: 0 };
    }
    async end() { this.closed = true; }
  }
  return { driver: { Pool }, servers, log };
}

const CONN = 'postgresql://postgres.abcdef:topsecretpw@aws-0-eu.pooler.supabase.com:6543/postgres?sslmode=require';
const silent = { warn() {}, info() {}, error() {} };

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), 'semo0o-cloud-test-'));
}

// Build a real, migrated SQLite database with one identifiable tenant.
function makeDatabase(dir, name, tenantName = 'Cloud Co') {
  const file = path.join(dir, name);
  const db = new Database(file);
  const tenantId = id('tenant');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, tenantName, now());
  return { file, db, tenantId };
}

// -----------------------------------------------------------------------------
// Connection-string parsing + redaction
// -----------------------------------------------------------------------------

test('parseDatabaseUrl reads host/port/database/user and enables TLS for a managed host', () => {
  const parsed = parseDatabaseUrl(CONN);
  assert.equal(parsed.protocol, 'postgresql');
  assert.equal(parsed.host, 'aws-0-eu.pooler.supabase.com');
  assert.equal(parsed.port, 6543);
  assert.equal(parsed.database, 'postgres');
  assert.equal(parsed.user, 'postgres.abcdef');
  assert.equal(parsed.ssl, true);
  assert.ok(!parsed.redacted.includes('topsecretpw'), 'the redacted form must not contain the password');
});

test('parseDatabaseUrl defaults the port and disables TLS for a local host', () => {
  const parsed = parseDatabaseUrl('postgres://user:pw@localhost/mydb');
  assert.equal(parsed.port, 5432);
  assert.equal(parsed.ssl, false);
  assert.equal(parsed.database, 'mydb');
});

test('parseDatabaseUrl honours an explicit sslmode=disable on a remote host', () => {
  const parsed = parseDatabaseUrl('postgresql://u:p@db.example.com:5432/app?sslmode=disable');
  assert.equal(parsed.ssl, false);
});

test('parseDatabaseUrl fails closed on missing, malformed and non-postgres URLs', () => {
  assert.throws(() => parseDatabaseUrl(''), (e) => e.code === 'CLOUD_DB_URL_MISSING');
  assert.throws(() => parseDatabaseUrl('not a url'), (e) => e.code === 'CLOUD_DB_URL_INVALID');
  assert.throws(() => parseDatabaseUrl('mysql://u:p@host/db'), (e) => e.code === 'CLOUD_DB_URL_UNSUPPORTED_PROTOCOL');
});

test('redactDatabaseUrl masks the password and password-like query params, never throws', () => {
  const redacted = redactDatabaseUrl('postgresql://user:supersecret@host:5432/db?sslmode=require&password=xyz');
  assert.ok(!redacted.includes('supersecret'));
  assert.ok(!redacted.includes('password=xyz'));
  assert.ok(redacted.includes('host:5432'));
  assert.equal(redactDatabaseUrl('garbage'), '<invalid-database-url>');
  assert.equal(redactDatabaseUrl(''), '');
});

// -----------------------------------------------------------------------------
// Snapshot store contract (fake driver)
// -----------------------------------------------------------------------------

test('createPostgresSnapshotStore requires a driver exposing a Pool constructor', () => {
  assert.throws(() => createPostgresSnapshotStore({ connectionString: CONN }), (e) => e.code === 'CLOUD_DB_DRIVER_REQUIRED');
  assert.throws(() => createPostgresSnapshotStore({ connectionString: CONN, driver: {} }), (e) => e.code === 'CLOUD_DB_DRIVER_REQUIRED');
});

test('the snapshot store round-trips a snapshot and prunes to the retention limit', async () => {
  const { driver } = createFakePostgres();
  const store = createPostgresSnapshotStore({ connectionString: CONN, driver, logger: silent });
  await store.ensureSchema();
  assert.equal(await store.readLatest(), null);

  const payload = Buffer.from('sqlite-bytes');
  await store.write({ content: payload, sha256: 'a'.repeat(64), schemaVersion: 1, bytes: payload.length, label: 'agent.sqlite', createdAt: '2026-01-01T00:00:00.000Z' });
  await store.write({ content: payload, sha256: 'b'.repeat(64), schemaVersion: 1, bytes: payload.length, label: 'agent.sqlite', createdAt: '2026-01-02T00:00:00.000Z' });

  const latest = await store.readLatest();
  assert.equal(latest.sha256, 'b'.repeat(64), 'readLatest returns the newest snapshot');
  assert.ok(Buffer.isBuffer(latest.content) && latest.content.equals(payload));

  await store.write({ content: payload, sha256: 'c'.repeat(64), schemaVersion: 1, bytes: payload.length, createdAt: '2026-01-03T00:00:00.000Z' });
  const pruned = await store.prune(2);
  assert.equal(pruned, 1, 'prune removes everything beyond the retention limit');
  assert.equal((await store.readLatest()).sha256, 'c'.repeat(64));
  await store.close();
});

// -----------------------------------------------------------------------------
// Live sync + restore-if-empty lifecycle (simulated redeploy)
// -----------------------------------------------------------------------------

test('syncSnapshotToCloud uploads a real snapshot then reports UNCHANGED for an identical database', async () => {
  const dir = await tempDir();
  const { driver, servers } = createFakePostgres();
  const store = createPostgresSnapshotStore({ connectionString: CONN, driver, logger: silent });
  try {
    const { file, db } = makeDatabase(dir, 'agent.sqlite');
    try {
      const first = await syncSnapshotToCloud({ databaseFile: file, store, logger: silent });
      assert.equal(first.uploaded, true);
      assert.equal(first.schemaVersion, 1);
      assert.ok(first.bytes > 0);
      assert.equal(servers.get(CONN).length, 1);

      const second = await syncSnapshotToCloud({ databaseFile: file, store, logger: silent });
      assert.equal(second.uploaded, false);
      assert.equal(second.reason, 'UNCHANGED');
      assert.equal(servers.get(CONN).length, 1, 'an unchanged database must not create a duplicate row');
    } finally { db.close(); }
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('restoreFromCloudIfEmpty restores the newest snapshot after the local file is wiped (redeploy)', async () => {
  const dir = await tempDir();
  const { driver } = createFakePostgres();
  const writer = createPostgresSnapshotStore({ connectionString: CONN, driver, logger: silent });
  try {
    const { file, db, tenantId } = makeDatabase(dir, 'agent.sqlite', 'Durable Co');
    await syncSnapshotToCloud({ databaseFile: file, store: writer, logger: silent });
    db.close();

    // Simulate a Render Free redeploy: the container filesystem is wiped.
    await rm(file, { force: true });
    await rm(`${file}-wal`, { force: true });
    await rm(`${file}-shm`, { force: true });
    assert.equal(existsSync(file), false);

    // A brand-new store (new "process") reads the snapshot back.
    const reader = createPostgresSnapshotStore({ connectionString: CONN, driver, logger: silent });
    try {
      const result = await restoreFromCloudIfEmpty({ databaseFile: file, store: reader, logger: silent });
      assert.equal(result.restored, true);
      assert.ok(existsSync(file));

      const restored = new Database(file);
      try {
        const row = restored.get('SELECT name FROM tenants WHERE id = ?', tenantId);
        assert.equal(row.name, 'Durable Co', 'the tenant survived the redeploy');
      } finally { restored.close(); }
    } finally { await reader.close(); }
  } finally {
    await writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('restoreFromCloudIfEmpty skips a non-empty local database and reports NO_SNAPSHOT when the cloud is empty', async () => {
  const dir = await tempDir();
  const { driver } = createFakePostgres();
  const store = createPostgresSnapshotStore({ connectionString: CONN, driver, logger: silent });
  try {
    const { file, db } = makeDatabase(dir, 'agent.sqlite', 'Existing Co');
    try {
      const skipped = await restoreFromCloudIfEmpty({ databaseFile: file, store, logger: silent });
      assert.equal(skipped.restored, false);
      assert.equal(skipped.reason, 'LOCAL_NOT_EMPTY');
    } finally { db.close(); }

    const empty = path.join(dir, 'fresh.sqlite');
    const none = await restoreFromCloudIfEmpty({ databaseFile: empty, store, logger: silent });
    assert.equal(none.restored, false);
    assert.equal(none.reason, 'NO_SNAPSHOT');
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('isLocalDatabaseEmpty treats a missing, fresh or tenant-less database as empty', async () => {
  const dir = await tempDir();
  try {
    assert.equal(isLocalDatabaseEmpty(path.join(dir, 'missing.sqlite')), true);
    const fresh = new Database(path.join(dir, 'fresh.sqlite'));
    fresh.close();
    assert.equal(isLocalDatabaseEmpty(path.join(dir, 'fresh.sqlite')), true);
    const { file, db } = makeDatabase(dir, 'with-tenant.sqlite');
    try { assert.equal(isLocalDatabaseEmpty(file), false); } finally { db.close(); }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------------
// startCloudPersistence controller + graceful degradation
// -----------------------------------------------------------------------------

test('startCloudPersistence is a safe no-op without DATABASE_URL', async () => {
  const controller = await startCloudPersistence({ env: {}, logger: silent });
  assert.equal(controller.enabled, false);
  assert.equal(controller.reason, 'NO_DATABASE_URL');
  assert.deepEqual(await controller.syncNow(), { uploaded: false, reason: 'DISABLED' });
  assert.deepEqual(await controller.stop(), { uploaded: false, reason: 'DISABLED' });
});

test('startCloudPersistence degrades to local SQLite when no driver is available', async () => {
  const controller = await startCloudPersistence({ env: { DATABASE_URL: CONN }, loadDriver: async () => null, logger: silent });
  assert.equal(controller.enabled, false);
  assert.equal(controller.reason, 'NO_DRIVER');
  assert.equal(await controller.syncNow().then((r) => r.uploaded), false);
});

test('startCloudPersistence reports an invalid DATABASE_URL instead of crashing', async () => {
  const controller = await startCloudPersistence({ env: { DATABASE_URL: 'mysql://nope' }, logger: silent });
  assert.equal(controller.enabled, false);
  assert.equal(controller.reason, 'CLOUD_DB_URL_UNSUPPORTED_PROTOCOL');
});

test('startCloudPersistence restores on boot, syncs on demand and flushes on stop', async () => {
  const dir = await tempDir();
  const { driver, servers } = createFakePostgres();
  try {
    // Seed the cloud with a snapshot from a previous "deployment".
    const seedStore = createPostgresSnapshotStore({ connectionString: CONN, driver, logger: silent });
    const seed = makeDatabase(dir, 'seed.sqlite', 'Seeded Co');
    await syncSnapshotToCloud({ databaseFile: seed.file, store: seedStore, logger: silent });
    seed.db.close();
    await seedStore.close();

    // New deployment: local database absent, DATABASE_URL set, fake driver wired in.
    const liveFile = path.join(dir, 'agent.sqlite');
    const controller = await startCloudPersistence({
      env: { DATABASE_URL: CONN },
      databaseFile: liveFile,
      driver,
      logger: silent,
      syncIntervalMs: 0, // no background timer in tests
    });
    assert.equal(controller.enabled, true);
    assert.equal(controller.restore.restored, true);
    assert.ok(!controller.config.redacted.includes('topsecretpw'));

    // The restored database is usable and carries the seeded tenant.
    const db = new Database(liveFile);
    try {
      assert.equal(db.get('SELECT COUNT(*) AS count FROM tenants').count, 1);
      db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', id('tenant'), 'Second Co', now());
    } finally { db.close(); }

    // A forced sync uploads the new state; the final stop() flush then sees an
    // identical database and correctly reports UNCHANGED (no duplicate row).
    const synced = await controller.syncNow();
    assert.equal(synced.uploaded, true);
    const stopped = await controller.stop();
    assert.equal(stopped.uploaded, false);
    assert.equal(stopped.reason, 'UNCHANGED');
    assert.ok(servers.get(CONN).length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveCloudStore returns a classified reason when the URL is missing or the driver is absent', async () => {
  assert.equal((await resolveCloudStore({ env: {}, logger: silent })).reason, 'NO_DATABASE_URL');
  assert.equal((await resolveCloudStore({ env: { DATABASE_URL: CONN }, loadDriver: async () => null, logger: silent })).reason, 'NO_DRIVER');
  const ok = await resolveCloudStore({ env: { DATABASE_URL: CONN }, driver: createFakePostgres().driver, logger: silent });
  assert.equal(ok.reason, 'ENABLED');
  assert.ok(ok.store);
  await ok.store.close();
});

test('DEFAULT_SNAPSHOT_RETENTION is a small, bounded number', () => {
  assert.ok(Number.isInteger(DEFAULT_SNAPSHOT_RETENTION) && DEFAULT_SNAPSHOT_RETENTION >= 1 && DEFAULT_SNAPSHOT_RETENTION <= 20);
});

// -----------------------------------------------------------------------------
// Default driver wiring (runs only when the optional `pg` dependency is present)
// -----------------------------------------------------------------------------

test('loadDefaultDriver returns the pg driver when installed (optional dependency)', async () => {
  const driver = await loadDefaultDriver(silent);
  if (driver === null) {
    // pg is optional; absence is a valid, graceful state.
    assert.ok(true);
    return;
  }
  assert.equal(typeof driver.Pool, 'function');
});
