import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database } from '../db/client.mjs';
import { CreationStudio } from '../creation/studio.mjs';
import { CreationJobStore } from '../creation/job-store.mjs';
import { createLocalOnlyProviders } from '../creation/index.mjs';
import { backupDatabase, restoreDatabase, verifyDatabase } from '../ops/sqlite-archive.mjs';

/**
 * Durable persistence for the Creation Studio (Point 2 of the remediation).
 *
 * The Director's jobs used to live only in a bounded in-memory Map, so a restart
 * lost every job AND every artifact. These tests prove the new write-through
 * store actually delivers durability:
 *
 *   1. a completed job + its artifact bytes survive a simulated restart;
 *   2. a job that was mid-flight when the process stopped is honestly reported
 *      as interrupted (never silently lost, never faked as completed);
 *   3. the existing encrypted-backup primitive (VACUUM INTO) round-trips the new
 *      tables and the artifact bytes intact.
 *
 * They assert on real bytes read back from a real SQLite file - nothing is stubbed.
 */

// A budget that still produces real GIF/AVI/bundle artifacts but stays fast.
const FAST = { resolution: 'draft', fps: 6, duration: 4 };

function waitForJob(studio, id, tenantId, { timeoutMs = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const view = studio.status(id, tenantId);
      if (view && ['completed', 'failed', 'cancelled'].includes(view.status)) return resolve(view);
      if (Date.now() - started > timeoutMs) return reject(new Error('STUDIO_JOB_TIMEOUT'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-creation-persist-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  return { dir, db, close: async () => { try { db.close(); } catch { /* ignore */ } await rm(dir, { recursive: true, force: true }); } };
}

test('studio: a completed job and its artifacts survive a simulated restart', async () => {
  const fx = await fixture();
  try {
    const studio1 = new CreationStudio({ providers: createLocalOnlyProviders(), db: fx.db });
    const started = studio1.start({ goal: 'Durable promo for a coffee brand', tenantId: 'tenant-a', userId: 'u1', options: FAST });
    const done = await waitForJob(studio1, started.id, 'tenant-a');
    assert.equal(done.status, 'completed', done.error || '');
    assert.ok(done.artifacts.gif && done.artifacts.gif.bytes > 0);
    assert.ok(done.artifacts.avi && done.artifacts.avi.bytes > 0);

    // Capture the exact bytes the first process produced.
    const originalGif = studio1.artifact(started.id, 'gif', 'tenant-a').buffer;
    const originalAvi = studio1.artifact(started.id, 'avi', 'tenant-a').buffer;
    assert.ok(originalGif.length > 0 && originalAvi.length > 0);

    // A brand-new studio over the SAME database == a fresh process boot.
    const studio2 = new CreationStudio({ providers: createLocalOnlyProviders(), db: fx.db });
    const recovered = studio2.status(started.id, 'tenant-a');
    assert.ok(recovered, 'the completed job must be rehydrated after restart');
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.artifacts.gif.bytes, originalGif.length);
    assert.equal(recovered.artifacts.avi.bytes, originalAvi.length);

    // The artifact is downloadable again, byte-for-byte, from durable storage.
    const reGif = studio2.artifact(started.id, 'gif', 'tenant-a');
    assert.ok(reGif && Buffer.compare(reGif.buffer, originalGif) === 0, 'restored GIF must match the original bytes');
    const reAvi = studio2.artifact(started.id, 'avi', 'tenant-a');
    assert.ok(reAvi && Buffer.compare(reAvi.buffer, originalAvi) === 0, 'restored AVI must match the original bytes');

    // The events were replayed too, and the job is listable.
    const snapshot = studio2.events(started.id, 'tenant-a', 0);
    assert.ok(snapshot && snapshot.events.length > 0);
    assert.ok(snapshot.events.some((e) => e.type === 'job.completed'));
    assert.ok(studio2.list('tenant-a').some((j) => j.id === started.id));

    // Tenant isolation is preserved across the durable boundary.
    assert.equal(studio2.status(started.id, 'tenant-b'), null);
    assert.equal(studio2.artifact(started.id, 'gif', 'tenant-b'), null);
  } finally { await fx.close(); }
});

test('studio: a job interrupted by a restart is honestly reported, never lost', async () => {
  const fx = await fixture();
  try {
    const store = new CreationJobStore(fx.db);
    const nowIso = new Date().toISOString();
    // Simulate a job that was 'running' when the process died: persist a running
    // row + a couple of events, then boot a studio over the same database.
    store.saveJob({
      id: 'cre_interrupted_1', tenantId: 'tenant-a', userId: 'u1', goal: 'half-done job',
      options: {}, status: 'running', createdAt: nowIso, updatedAt: nowIso,
      startedAt: Date.now() - 5000, elapsedMs: 0, progress: { stage: 'render', done: 3, total: 10 }, result: null, error: null,
    });
    store.appendEvent('cre_interrupted_1', 'tenant-a', { seq: 1, type: 'job.started', payload: {}, at: nowIso });
    store.appendEvent('cre_interrupted_1', 'tenant-a', { seq: 2, type: 'stage', payload: { stage: 'render' }, at: nowIso });
    assert.equal(store.interrupted().length, 1);

    const studio = new CreationStudio({ providers: createLocalOnlyProviders(), db: fx.db });
    const view = studio.status('cre_interrupted_1', 'tenant-a');
    assert.ok(view, 'the interrupted job must still be visible');
    assert.equal(view.status, 'failed');
    assert.equal(view.error, 'CREATION_INTERRUPTED_BY_RESTART');
    // The durable store now agrees - it is no longer "running".
    assert.equal(store.interrupted().length, 0);
    // And the recovery summary is honest about what happened.
    const recovery = studio.recovery();
    assert.equal(recovery.durable, true);
    assert.ok(recovery.loaded >= 1);
  } finally { await fx.close(); }
});

test('backup/restore round-trips creation jobs and artifact bytes', async () => {
  const fx = await fixture();
  try {
    const studio = new CreationStudio({ providers: createLocalOnlyProviders(), db: fx.db });
    const started = studio.start({ goal: 'Backup round-trip deliverable', tenantId: 'tenant-a', options: FAST });
    const done = await waitForJob(studio, started.id, 'tenant-a');
    assert.equal(done.status, 'completed', done.error || '');
    const originalGif = studio.artifact(started.id, 'gif', 'tenant-a').buffer;

    const backupPath = path.join(fx.dir, 'snapshot.sqlite');
    const restoredPath = path.join(fx.dir, 'restored.sqlite');
    await backupDatabase(fx.db.file, backupPath);
    const verified = await verifyDatabase(backupPath);
    assert.equal(verified.operation, 'verify');
    assert.ok(verified.schemaVersion >= 1);
    await restoreDatabase(backupPath, restoredPath);

    // Open the restored database independently and prove the job + bytes are intact.
    const restored = new Database(restoredPath);
    try {
      const store = new CreationJobStore(restored);
      const job = store.loadJob(started.id);
      assert.ok(job, 'the job row must exist in the restored database');
      assert.equal(job.status, 'completed');
      assert.equal(job.tenantId, 'tenant-a');
      const artifact = store.loadArtifact(started.id, 'gif');
      assert.ok(artifact, 'the artifact bytes must exist in the restored database');
      assert.equal(artifact.bytes, originalGif.length);
      assert.ok(Buffer.compare(artifact.buffer, originalGif) === 0, 'restored bytes must match the original');
      // The stored hash is verified against the restored bytes (tamper-evident).
      const check = store.verifyArtifact(started.id, 'gif');
      assert.equal(check.ok, true);
      // Events round-trip too.
      assert.ok(store.loadEvents(started.id, 0).length > 0);
    } finally { restored.close(); }
  } finally { await fx.close(); }
});
