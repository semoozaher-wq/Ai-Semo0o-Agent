import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { parseGif } from '../media/gif.mjs';

/**
 * The Creation Studio runs the Director — including the CPU-heavy, synchronous
 * render — in the SAME process and event loop as this test's HTTP server. A long
 * render can therefore stall the server long enough for the platform to drop an
 * in-flight request, which surfaces as a transient `TypeError: fetch failed`
 * (undici) on CI runners that are slower or more contended than a dev box. These
 * are connection-level failures, not application errors, so retry ONLY those —
 * a real HTTP status or an assertion failure is never retried or masked.
 */
const TRANSIENT_FETCH_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
function isTransientFetchError(error) {
  if (!error) return false;
  const code = error.cause?.code ?? error.code;
  if (code && TRANSIENT_FETCH_CODES.has(code)) return true;
  return error.name === 'TypeError' && /fetch failed/i.test(error.message ?? '');
}

/**
 * Creation Studio integration: the /creation/* HTTP surface and the studio.*
 * tools must turn ONE goal into a real, downloadable deliverable end-to-end,
 * with honest status, tenant scoping and validation — against a real server +
 * SQLite database.
 */

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-creation-studio-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const send = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const contentType = response.headers.get('content-type') || '';
    return {
      status: response.status,
      contentType,
      headers: response.headers,
      body: contentType.includes('application/json') ? await response.json().catch(() => ({})) : null,
      bytes: contentType.includes('application/json') ? null : Buffer.from(await response.arrayBuffer()),
    };
  };
  // Retry a dropped connection a few times with a short backoff. Only the
  // connection-level errors above are retried; an HTTP response (even 4xx/5xx)
  // is returned as-is so the assertions still see the real behaviour.
  const request = async (route, options = {}) => {
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await send(route, options);
      } catch (error) {
        lastError = error;
        if (!isTransientFetchError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw lastError;
  };
  return {
    dir, db, queue, app, base, request,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function ownerFixture(fx) {
  createUser(fx.db, { email: 'studio-routes@test', password: 'correct horse battery staple', tenantName: 'StudioRoutes' });
  const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'studio-routes@test', password: 'correct horse battery staple' } });
  return { token: login.body.session.token };
}

async function waitForJob(fx, token, id, { timeoutMs = 90_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fx.request(`/creation/jobs/${id}`, { token });
    assert.equal(res.status, 200);
    if (['completed', 'failed', 'cancelled'].includes(res.body.status)) return res.body;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('CREATION_JOB_TIMEOUT');
}

/* ------------------------------------------------------------------ */
/* HTTP surface                                                        */
/* ------------------------------------------------------------------ */

test('GET /creation/capabilities is authenticated and honest', async () => {
  const fx = await fixture();
  try {
    const anon = await fx.request('/creation/capabilities');
    assert.equal(anon.status, 401);

    const { token } = await ownerFixture(fx);
    const res = await fx.request('/creation/capabilities', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.kernel, true);
    assert.equal(res.body.localStudio, true);
    assert.deepEqual(res.body.formats, ['gif', 'avi', 'png', 'bundle']);
    assert.ok(res.body.providers && typeof res.body.providers === 'object');
  } finally { await fx.close(); }
});

test('POST /creation/jobs validates the goal', async () => {
  const fx = await fixture();
  try {
    const { token } = await ownerFixture(fx);
    const empty = await fx.request('/creation/jobs', { method: 'POST', token, body: { goal: '   ' } });
    assert.equal(empty.status, 400);
    assert.match(empty.body.error, /INVALID_GOAL/);

    const tooLong = await fx.request('/creation/jobs', { method: 'POST', token, body: { goal: 'x'.repeat(5000) } });
    assert.equal(tooLong.status, 400);
  } finally { await fx.close(); }
});

test('POST /creation/plan returns a plan without rendering', async () => {
  const fx = await fixture();
  try {
    const { token } = await ownerFixture(fx);
    const res = await fx.request('/creation/plan', {
      method: 'POST', token,
      body: { goal: 'Tutorial: brew pour-over coffee', format: 'portrait', duration: 12, resolution: 'draft' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.brief && res.body.storyboard && res.body.bibles && res.body.prompts);
    assert.equal(res.body.prompts.length, res.body.storyboard.scenes.length);
    assert.equal(res.body.brief.format, 'portrait');
  } finally { await fx.close(); }
});

test('one goal → real downloadable GIF + AVI + bundle via /creation/jobs', async () => {
  const fx = await fixture();
  try {
    const { token } = await ownerFixture(fx);
    const started = await fx.request('/creation/jobs', {
      method: 'POST', token,
      body: { goal: 'Launch video for our new AI note-taking app', resolution: 'draft', fps: 8, duration: 6 },
    });
    assert.equal(started.status, 202);
    assert.equal(started.body.status, 'running');
    const id = started.body.id;
    assert.match(id, /^cre_/);

    const done = await waitForJob(fx, token, id);
    assert.equal(done.status, 'completed', done.error || '');
    assert.ok(done.result.brief && done.result.storyboard && done.result.timeline);
    assert.ok(done.result.iterations.length >= 1);
    assert.ok(done.artifacts.gif && done.artifacts.gif.bytes > 0);
    assert.ok(done.artifacts.avi && done.artifacts.avi.bytes > 0);
    assert.ok(done.artifacts.bundle && done.artifacts.bundle.bytes > 0);

    // Events were streamed and are replayable.
    const events = await fx.request(`/creation/jobs/${id}/events`, { token });
    assert.equal(events.status, 200);
    assert.ok(events.body.events.length > 0);
    assert.ok(events.body.events.some((e) => e.type === 'stage'));

    // Artifacts download as real binaries with the right content-type.
    const gif = await fx.request(`/creation/jobs/${id}/artifacts/gif`, { token });
    assert.equal(gif.status, 200);
    assert.match(gif.contentType, /image\/gif/);
    assert.match(gif.headers.get('content-disposition') || '', /attachment/);
    const parsed = parseGif(gif.bytes);
    assert.ok(parsed.width > 0 && parsed.height > 0);
    assert.ok(parsed.frames > 1);

    const avi = await fx.request(`/creation/jobs/${id}/artifacts/avi`, { token });
    assert.equal(avi.status, 200);
    assert.match(avi.contentType, /video\/x-msvideo/);
    assert.ok(avi.bytes.length > 1000);

    const bundle = await fx.request(`/creation/jobs/${id}/artifacts/bundle`, { token });
    assert.equal(bundle.status, 200);
    assert.match(bundle.contentType, /application\/zip/);
    assert.equal(bundle.bytes.subarray(0, 2).toString('latin1'), 'PK');

    // The job appears in the tenant's list.
    const list = await fx.request('/creation/jobs', { token });
    assert.equal(list.status, 200);
    assert.ok(list.body.jobs.some((j) => j.id === id));
  } finally { await fx.close(); }
});

test('creation routes are tenant-scoped and return honest 404s', async () => {
  const fx = await fixture();
  try {
    const { token } = await ownerFixture(fx);
    const missing = await fx.request('/creation/jobs/cre_does_not_exist', { token });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /CREATION_JOB_NOT_FOUND/);

    const missingArtifact = await fx.request('/creation/jobs/cre_does_not_exist/artifacts/gif', { token });
    assert.equal(missingArtifact.status, 404);

    const cancelMissing = await fx.request('/creation/jobs/cre_does_not_exist/cancel', { method: 'POST', token });
    assert.equal(cancelMissing.status, 404);
  } finally { await fx.close(); }
});

test('creation jobs are isolated across tenants end-to-end', async () => {
  const fx = await fixture();
  try {
    // Two independent tenants.
    createUser(fx.db, { email: 'studio-a@test', password: 'correct horse battery staple', tenantName: 'TenantA' });
    createUser(fx.db, { email: 'studio-b@test', password: 'correct horse battery staple', tenantName: 'TenantB' });
    const loginA = await fx.request('/auth/login', { method: 'POST', body: { email: 'studio-a@test', password: 'correct horse battery staple' } });
    const loginB = await fx.request('/auth/login', { method: 'POST', body: { email: 'studio-b@test', password: 'correct horse battery staple' } });
    const tokenA = loginA.body.session.token;
    const tokenB = loginB.body.session.token;

    const started = await fx.request('/creation/jobs', {
      method: 'POST', token: tokenA,
      body: { goal: 'Tenant A private launch video', resolution: 'draft', fps: 8, duration: 6 },
    });
    assert.equal(started.status, 202);
    const id = started.body.id;

    // Tenant B can neither read, list, stream, download nor cancel tenant A's job.
    const read = await fx.request(`/creation/jobs/${id}`, { token: tokenB });
    assert.equal(read.status, 404);
    assert.match(read.body.error, /CREATION_JOB_NOT_FOUND/);

    const listB = await fx.request('/creation/jobs', { token: tokenB });
    assert.equal(listB.status, 200);
    assert.ok(!listB.body.jobs.some((j) => j.id === id));

    const artifact = await fx.request(`/creation/jobs/${id}/artifacts/gif`, { token: tokenB });
    assert.equal(artifact.status, 404);

    const cancel = await fx.request(`/creation/jobs/${id}/cancel`, { method: 'POST', token: tokenB });
    assert.equal(cancel.status, 404);

    // The owner still sees its own job.
    const listA = await fx.request('/creation/jobs', { token: tokenA });
    assert.equal(listA.status, 200);
    assert.ok(listA.body.jobs.some((j) => j.id === id));
  } finally { await fx.close(); }
});

/* ------------------------------------------------------------------ */
/* studio.* tools                                                      */
/* ------------------------------------------------------------------ */

test('studio tools are registered live and plan without rendering', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-studio-tools-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const tools = createLiveToolRegistry({ db, getWorkspaceRoot: () => dir });
    const status = tools.status();
    for (const id of ['studio.plan', 'studio.create', 'studio.render']) {
      assert.ok(status.live.includes(id), `${id} should be live`);
    }
    const plan = await tools.run('studio.plan', { goal: 'Promo for a coffee subscription', duration: 10, resolution: 'draft' }, { workspaceRoot: dir });
    assert.ok(plan.output.brief && plan.output.storyboard && plan.output.prompts);
    assert.equal(plan.output.prompts.length, plan.output.storyboard.scenes.length);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('studio.create writes real media files into the workspace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-studio-create-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  try {
    const tools = createLiveToolRegistry({ db, getWorkspaceRoot: () => dir });
    const result = await tools.run('studio.create', {
      goal: 'Launch video for a smart water bottle',
      resolution: 'draft', fps: 8, duration: 6, directory: 'out',
    }, { workspaceRoot: dir });
    assert.ok(result.output.manifest.frameCount > 0);
    assert.equal(result.output.files.gif.path, 'out/video.gif');
    assert.equal(result.output.files.avi.path, 'out/video.avi');
    assert.equal(result.output.files.bundle.path, 'out/bundle.zip');
    const gifStat = await stat(path.join(dir, 'out/video.gif'));
    assert.ok(gifStat.size > 0);
    const bundleStat = await stat(path.join(dir, 'out/bundle.zip'));
    assert.ok(bundleStat.size > 0);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
