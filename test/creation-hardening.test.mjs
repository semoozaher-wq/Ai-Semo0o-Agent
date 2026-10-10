import assert from 'node:assert/strict';
import test from 'node:test';

import { CreationStudio } from '../creation/studio.mjs';
import { normalizeBudget, runDirector, createLocalOnlyProviders } from '../creation/index.mjs';

/**
 * Hardening regression suite for the Creation Studio / Director:
 *
 *   1. Tenant isolation of CreationStudio.get() / list() — a caller can only
 *      ever reach jobs that belong to its OWN tenant (fail-closed).
 *   2. Caller options can never replace the studio's internal AbortSignal or
 *      onEvent sink, so cancellation and event tracking cannot be disabled.
 *   3. `maxIterations = 0` (and other degenerate budgets) in director.mjs must
 *      not crash the encode stage.
 *
 * These tests assert on the real, observable behaviour of the modules — they do
 * not stub the director out.
 */

/** Poll a studio job to a terminal state (tenant-scoped, like the HTTP layer). */
function waitForJob(studio, id, tenantId, { timeoutMs = 60_000 } = {}) {
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

// A budget that keeps a real run fast (no CPU-heavy GIF/AVI/bundle encoding).
const FAST = { resolution: 'draft', fps: 6, duration: 4, formats: false, bundle: false };

/* ------------------------------------------------------------------ */
/* 1. Tenant isolation                                                 */
/* ------------------------------------------------------------------ */

test('studio: get() is tenant-isolated and fail-closed', async () => {
  const studio = new CreationStudio({ providers: createLocalOnlyProviders() });
  const a = studio.start({ goal: 'promo A', tenantId: 'tenant-a', userId: 'ua', options: FAST });
  const b = studio.start({ goal: 'promo B', tenantId: 'tenant-b', userId: 'ub', options: FAST });
  const unowned = studio.start({ goal: 'system job', options: FAST });

  // The owner sees its own job.
  assert.ok(studio.get(a.id, 'tenant-a'));
  assert.ok(studio.get(b.id, 'tenant-b'));

  // Another tenant never sees it (exact-match, fail-closed).
  assert.equal(studio.get(a.id, 'tenant-b'), null);
  assert.equal(studio.get(b.id, 'tenant-a'), null);

  // A caller with no tenant never sees a tenant-owned job — whether it passes
  // null explicitly or omits the argument entirely.
  assert.equal(studio.get(a.id, null), null);
  assert.equal(studio.get(a.id), null);

  // A tenant-scoped caller never sees an unowned/system job, and a tenantless
  // caller never sees a tenant-owned job.
  assert.equal(studio.get(unowned.id, 'tenant-a'), null);
  assert.equal(studio.get(unowned.id, 'tenant-b'), null);
  assert.ok(studio.get(unowned.id, null));

  // Unknown ids stay unknown.
  assert.equal(studio.get('cre_missing', 'tenant-a'), null);

  await Promise.all([
    waitForJob(studio, a.id, 'tenant-a'),
    waitForJob(studio, b.id, 'tenant-b'),
    waitForJob(studio, unowned.id, null),
  ]);
});

test('studio: list() only ever returns the caller tenant\'s jobs', async () => {
  const studio = new CreationStudio({ providers: createLocalOnlyProviders() });
  const a = studio.start({ goal: 'promo A', tenantId: 'tenant-a', options: FAST });
  const b = studio.start({ goal: 'promo B', tenantId: 'tenant-b', options: FAST });
  const unowned = studio.start({ goal: 'system job', options: FAST });

  assert.deepEqual(studio.list('tenant-a').map((j) => j.id), [a.id]);
  assert.deepEqual(studio.list('tenant-b').map((j) => j.id), [b.id]);
  // A tenantless caller sees ONLY unowned jobs — never a tenant's jobs.
  assert.deepEqual(studio.list(null).map((j) => j.id), [unowned.id]);
  // An unrelated tenant sees nothing.
  assert.deepEqual(studio.list('tenant-c'), []);

  await Promise.all([
    waitForJob(studio, a.id, 'tenant-a'),
    waitForJob(studio, b.id, 'tenant-b'),
    waitForJob(studio, unowned.id, null),
  ]);
});

/* ------------------------------------------------------------------ */
/* 2. Internal signal / onEvent are authoritative                      */
/* ------------------------------------------------------------------ */

test('studio: caller options cannot override the internal signal or onEvent', async () => {
  const studio = new CreationStudio({ providers: createLocalOnlyProviders() });
  // A pre-aborted signal + a hostile onEvent, both smuggled into `options`.
  const aborted = new AbortController();
  aborted.abort();
  let hijacked = 0;
  const job = studio.start({
    goal: 'Launch video for a smart water bottle',
    tenantId: 'tenant-x',
    userId: 'ux',
    options: {
      ...FAST,
      signal: aborted.signal,                 // must be IGNORED (would cancel the run)
      onEvent: () => { hijacked += 1; },      // must be IGNORED (would hijack events)
    },
  });

  const done = await waitForJob(studio, job.id, 'tenant-x');

  // If the caller's aborted signal had been honoured the run would be cancelled.
  assert.equal(done.status, 'completed', done.error || '');
  // The caller's onEvent was never invoked; the internal sink recorded events.
  assert.equal(hijacked, 0);
  const snapshot = studio.events(job.id, 'tenant-x', 0);
  assert.ok(snapshot.events.length > 0);
  assert.ok(snapshot.events.some((e) => e.type === 'stage'));
  assert.ok(snapshot.events.some((e) => e.type === 'job.completed' || e.type === 'deliver'));
});

test('studio: cancel() still aborts through the internal signal', async () => {
  const studio = new CreationStudio({ providers: createLocalOnlyProviders() });
  const job = studio.start({
    goal: 'A long cinematic launch video',
    tenantId: 'tenant-y',
    userId: 'uy',
    options: { resolution: 'high', fps: 24, duration: 60, formats: true, bundle: true },
  });
  // cancel() runs synchronously BEFORE the deferred #run starts, so the internal
  // signal is aborted deterministically and the run reports cancellation.
  const cancelled = studio.cancel(job.id, 'tenant-y');
  assert.ok(cancelled);

  const done = await waitForJob(studio, job.id, 'tenant-y');
  assert.equal(done.status, 'cancelled');
});

test('studio: a caller with no tenant cannot cancel another tenant\'s job', async () => {
  const studio = new CreationStudio({ providers: createLocalOnlyProviders() });
  const job = studio.start({ goal: 'promo', tenantId: 'tenant-z', options: FAST });
  assert.equal(studio.cancel(job.id, 'tenant-other'), null);
  assert.equal(studio.cancel(job.id, null), null);
  await waitForJob(studio, job.id, 'tenant-z');
});

/* ------------------------------------------------------------------ */
/* 3. maxIterations edge cases                                         */
/* ------------------------------------------------------------------ */

test('director: normalizeBudget clamps degenerate maxIterations values', () => {
  assert.equal(normalizeBudget({}).maxIterations, 2);
  assert.equal(normalizeBudget({ budget: { maxIterations: 0 } }).maxIterations, 1);
  assert.equal(normalizeBudget({ budget: { maxIterations: -5 } }).maxIterations, 1);
  assert.equal(normalizeBudget({ budget: { maxIterations: 3.9 } }).maxIterations, 3);
  assert.equal(normalizeBudget({ budget: { maxIterations: '4' } }).maxIterations, 4);
  assert.equal(normalizeBudget({ budget: { maxIterations: 'abc' } }).maxIterations, 2);
  assert.equal(normalizeBudget({ budget: { maxIterations: NaN } }).maxIterations, 2);
  assert.equal(normalizeBudget({ budget: { maxIterations: Infinity } }).maxIterations, 2);
  assert.equal(normalizeBudget({ budget: { maxIterations: 9999 } }).maxIterations, 50);
  // Unrelated budget fields pass through untouched.
  assert.equal(normalizeBudget({ budget: { threshold: 0.5 } }).threshold, 0.5);
  assert.equal(normalizeBudget({ budget: { maxProviderCalls: 3 } }).maxProviderCalls, 3);
});

test('director: maxIterations = 0 still produces a real result (single pass)', async () => {
  const events = [];
  const result = await runDirector('Launch video for a smart water bottle', {
    ...FAST,
    budget: { maxIterations: 0 },
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.iterations.length, 1);
  assert.ok(result.manifest.frameCount > 0);
  assert.ok(result.brief && result.storyboard && result.timeline);
  assert.ok(events.some((e) => e.type === 'stage'));
});

test('director: a negative maxIterations degrades to a single pass', async () => {
  const result = await runDirector('promo', { ...FAST, budget: { maxIterations: -3 } });
  assert.equal(result.status, 'completed');
  assert.equal(result.iterations.length, 1);
});
