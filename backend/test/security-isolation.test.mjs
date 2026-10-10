import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database } from '../db/client.mjs';
import { CreationJobStore } from '../creation/job-store.mjs';
import {
  SandboxError,
  buildDockerInvocation,
  validateCodeRunRequest,
} from '../../execution-core/sandbox.mjs';

/**
 * Security regression suite (Point 5 of the remediation): tenant data isolation
 * at the *durable* boundary, plus the invariants of the code-execution sandbox.
 *
 * The in-memory CreationStudio isolation is covered by creation-hardening.test.mjs
 * and creation-persistence.test.mjs. This file proves the NEW durable store keeps
 * the same guarantee once jobs live in SQLite, and re-asserts that the sandbox
 * refuses anything unsafe before it ever reaches a container.
 */

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-security-iso-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  return { dir, db, close: async () => { try { db.close(); } catch { /* ignore */ } await rm(dir, { recursive: true, force: true }); } };
}

function seed(store, id, tenantId) {
  const now = new Date().toISOString();
  store.saveJob({
    id, tenantId, userId: 'u', goal: 'g', options: {}, status: 'completed',
    createdAt: now, updatedAt: now, startedAt: Date.now(), elapsedMs: 1,
    progress: {}, result: null, error: null,
  });
}

test('durable job store never leaks jobs across tenants (fail-closed)', async () => {
  const fx = await fixture();
  try {
    const store = new CreationJobStore(fx.db);
    seed(store, 'cre_a', 'tenant-a');
    seed(store, 'cre_b', 'tenant-b');
    seed(store, 'cre_sys', null);

    // A tenant sees only its own jobs.
    assert.deepEqual(store.listJobs('tenant-a').map((j) => j.id), ['cre_a']);
    assert.deepEqual(store.listJobs('tenant-b').map((j) => j.id), ['cre_b']);
    // A tenantless caller sees ONLY unowned jobs — never a tenant's.
    assert.deepEqual(store.listJobs(null).map((j) => j.id), ['cre_sys']);
    assert.deepEqual(store.listJobs().map((j) => j.id), ['cre_sys']);
    // An unrelated tenant sees nothing.
    assert.deepEqual(store.listJobs('tenant-c'), []);

    // listAll() is the internal hydration warm-up and is deliberately unscoped;
    // it is never exposed to a caller (the studio filters by tenant on read).
    assert.equal(store.listAll().length, 3);
  } finally { await fx.close(); }
});

test('durable artifact reads are job-scoped', async () => {
  const fx = await fixture();
  try {
    const store = new CreationJobStore(fx.db);
    seed(store, 'cre_a', 'tenant-a');
    seed(store, 'cre_b', 'tenant-b');
    store.saveArtifacts('cre_a', 'tenant-a', { gif: Buffer.from('AAAA') });
    store.saveArtifacts('cre_b', 'tenant-b', { gif: Buffer.from('BBBB') });

    // An artifact is only reachable through its own job id.
    assert.equal(store.loadArtifact('cre_a', 'gif').buffer.toString(), 'AAAA');
    assert.equal(store.loadArtifact('cre_b', 'gif').buffer.toString(), 'BBBB');
    assert.equal(store.loadArtifact('cre_a', 'avi'), null);
    assert.equal(store.loadArtifact('cre_missing', 'gif'), null);
    // The stored hash verifies against the stored bytes (tamper-evident).
    assert.equal(store.verifyArtifact('cre_a', 'gif').ok, true);
  } finally { await fx.close(); }
});

test('code-execution sandbox rejects unsafe requests before spawn', () => {
  // Unsupported language.
  assert.throws(
    () => validateCodeRunRequest({ language: 'ruby', source: 'puts 1' }),
    (e) => e instanceof SandboxError && e.code === 'UNSUPPORTED_LANGUAGE',
  );
  // Path traversal in a mounted file.
  assert.throws(
    () => validateCodeRunRequest({ language: 'javascript', source: '1', files: [{ path: '../escape.js', content: 'x' }] }),
    /normalized relative paths/i,
  );
  // Absolute path in a mounted file.
  assert.throws(
    () => validateCodeRunRequest({ language: 'javascript', source: '1', files: [{ path: '/etc/passwd', content: 'x' }] }),
    /normalized relative paths/i,
  );
  // Any network other than `none` is refused.
  assert.throws(
    () => validateCodeRunRequest({ language: 'javascript', source: '1', network: 'host' }),
    /network=none/i,
  );
  // Resource limits are capped at a safety maximum.
  assert.throws(
    () => validateCodeRunRequest({ language: 'javascript', source: '1', timeoutMs: 10_000_000 }),
    /safety maximum/i,
  );
  assert.throws(
    () => validateCodeRunRequest({ language: 'javascript', source: '1', memoryMb: 100_000 }),
    /safety maximum/i,
  );
});

test('code-execution sandbox hardens the container invocation', () => {
  const built = buildDockerInvocation({ language: 'python', source: 'print(1)' }, '/tmp/ws');
  for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges']) {
    assert.ok(built.args.includes(flag), `sandbox must pass ${flag}`);
  }
  // Runs as a non-root user and never as the default root.
  assert.ok(built.args.includes('--user=65532:65532'));
  assert.ok(built.args.some((a) => a.startsWith('--memory=')));
  assert.ok(built.args.some((a) => a.startsWith('--pids-limit=')));
  // The command is an argv array (no shell string) — no shell-injection surface.
  assert.ok(Array.isArray(built.request.command));
});
