import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';

/**
 * Trigger routes: the HTTP surface must accept, validate, persist and expose the
 * new scheduler fields (timezone + missed-run policy) end-to-end against a real
 * server + SQLite database.
 */

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-trigger-routes-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return {
    dir, db, queue, app, base, request,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

async function ownerFixture(fx) {
  const user = createUser(fx.db, { email: 'sched-routes@test', password: 'correct horse battery staple', tenantName: 'SchedRoutes' });
  const login = await fx.request('/auth/login', { method: 'POST', body: { email: 'sched-routes@test', password: 'correct horse battery staple' } });
  const token = login.body.session.token;
  const projectId = id('project');
  const workspaceId = id('workspace');
  fx.db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, user.tenant_id, user.id, 'P', now());
  fx.db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), now());
  return { user, token, projectId, workspaceId };
}

function localHour(iso, timeZone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false }).format(new Date(iso)));
}

test('POST /triggers persists and exposes timezone + missed-run policy', async () => {
  const fx = await fixture();
  try {
    const { token, projectId } = await ownerFixture(fx);
    const created = await fx.request('/triggers', {
      method: 'POST', token,
      body: { projectId, name: 'morning', kind: 'cron', schedule: '0 9 * * *', goal: 'daily audit', timezone: 'America/New_York', missedRunPolicy: 'skip' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.timezone, 'America/New_York');
    assert.equal(created.body.missedRunPolicy, 'skip');
    assert.equal(created.body.retryCount, 0);
    assert.ok(created.body.nextRunAt, 'nextRunAt must be computed');
    assert.equal(localHour(created.body.nextRunAt, 'America/New_York'), 9, 'next run must be 09:00 New York wall-clock');

    const list = await fx.request('/triggers', { token });
    assert.equal(list.status, 200);
    const found = list.body.triggers.find((t) => t.id === created.body.id);
    assert.ok(found);
    assert.equal(found.timezone, 'America/New_York');
    assert.equal(found.missedRunPolicy, 'skip');
  } finally { await fx.close(); }
});

test('POST /triggers defaults timezone to UTC and policy to catchup', async () => {
  const fx = await fixture();
  try {
    const { token, projectId } = await ownerFixture(fx);
    const created = await fx.request('/triggers', {
      method: 'POST', token,
      body: { projectId, name: 'plain', kind: 'cron', schedule: '0 9 * * *', goal: 'g' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.timezone, 'UTC');
    assert.equal(created.body.missedRunPolicy, 'catchup');
    assert.equal(localHour(created.body.nextRunAt, 'UTC'), 9);
  } finally { await fx.close(); }
});

test('POST /triggers rejects an invalid timezone and an invalid policy', async () => {
  const fx = await fixture();
  try {
    const { token, projectId } = await ownerFixture(fx);
    const badTz = await fx.request('/triggers', {
      method: 'POST', token,
      body: { projectId, name: 'bad', kind: 'cron', schedule: '0 9 * * *', goal: 'g', timezone: 'Mars/Phobos' },
    });
    assert.equal(badTz.status, 400);
    const badPolicy = await fx.request('/triggers', {
      method: 'POST', token,
      body: { projectId, name: 'bad', kind: 'cron', schedule: '0 9 * * *', goal: 'g', missedRunPolicy: 'explode' },
    });
    assert.equal(badPolicy.status, 400);
  } finally { await fx.close(); }
});

test('PATCH /triggers/:id updates timezone + policy and recomputes next run', async () => {
  const fx = await fixture();
  try {
    const { token, projectId } = await ownerFixture(fx);
    const created = await fx.request('/triggers', {
      method: 'POST', token,
      body: { projectId, name: 'p', kind: 'cron', schedule: '0 9 * * *', goal: 'g' },
    });
    assert.equal(created.status, 201);
    const patched = await fx.request(`/triggers/${created.body.id}`, {
      method: 'PATCH', token,
      body: { timezone: 'Asia/Riyadh', missedRunPolicy: 'run_all' },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.timezone, 'Asia/Riyadh');
    assert.equal(patched.body.missedRunPolicy, 'run_all');
    assert.equal(localHour(patched.body.nextRunAt, 'Asia/Riyadh'), 9, 'next run recomputed in the new zone');
    assert.notEqual(patched.body.nextRunAt, created.body.nextRunAt);
  } finally { await fx.close(); }
});
