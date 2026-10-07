import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, id, now } from '../db/client.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createApp } from '../server.mjs';

/**
 * Performance checks with deliberately generous thresholds: they exist to catch
 * a catastrophic regression (a runaway loop, an unbounded allocation, a lost
 * concurrency cap), not to benchmark a noisy shared CI box. The measured values
 * are printed so an operator can watch the trend.
 */

function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Perf Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'perf@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Perf Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'perf goal', 'queued', t, t);
  return { tenantId, taskId };
}

test('backend boots and answers /health within a bounded time', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-perf-boot-'));
  const db = new Database(path.join(dir, 'perf.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const started = Date.now();
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const response = await fetch(`${base}/health`);
    const bootMs = Date.now() - started;
    const body = await response.json();
    console.log(`[perf] boot+health: ${bootMs}ms`);
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.ok(bootMs < 10_000, `boot took ${bootMs}ms, expected < 10000ms`);
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the queue drains a burst of runs and honours its concurrency cap', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-perf-queue-'));
  const db = new Database(path.join(dir, 'perf.sqlite'));
  const { tenantId, taskId } = seed(db);
  const LIMIT = 4;
  const JOBS = 30;
  let inFlight = 0;
  let peak = 0;
  // The handler is slower than the poll interval so ticks genuinely overlap and
  // the concurrency cap is actually exercised.
  const queue = new RunQueue(db, { pollMs: 3, concurrency: LIMIT });
  queue.register('code.run', async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight -= 1;
    return { status: 'completed', ok: true };
  });

  const ids = [];
  for (let index = 0; index < JOBS; index += 1) {
    ids.push(queue.enqueue({ taskId, tenantId, kind: 'code.run', payload: { language: 'bash', source: `echo ${index}` } }).id);
  }

  const started = Date.now();
  queue.start();
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('queue did not drain in time')), 20_000);
      const check = setInterval(() => {
        const done = db.all(`SELECT status FROM runs WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
          .filter((row) => ['completed', 'failed', 'cancelled', 'unverified'].includes(row.status)).length;
        if (done === JOBS) { clearInterval(check); clearTimeout(deadline); resolve(); }
      }, 10);
    });
    const drainMs = Date.now() - started;
    console.log(`[perf] drained ${JOBS} runs in ${drainMs}ms (peak concurrency ${peak})`);
    const completed = db.all(`SELECT status FROM runs WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).filter((row) => row.status === 'completed').length;
    assert.equal(completed, JOBS, 'every run must complete');
    assert.ok(peak <= LIMIT, `peak concurrency ${peak} must not exceed the cap ${LIMIT}`);
    assert.ok(peak >= 2, `the queue must actually run concurrently (peak ${peak})`);
    assert.ok(drainMs < 20_000, `drain took ${drainMs}ms, expected < 20000ms`);
  } finally {
    queue.stop();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('resident memory stays bounded after a burst of runs', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-perf-mem-'));
  const db = new Database(path.join(dir, 'perf.sqlite'));
  const { tenantId, taskId } = seed(db);
  const queue = new RunQueue(db, { pollMs: 5, concurrency: 4 });
  queue.register('code.run', async () => ({ status: 'completed', ok: true, stdout: 'x'.repeat(1024) }));
  const ids = [];
  for (let index = 0; index < 50; index += 1) ids.push(queue.enqueue({ taskId, tenantId, kind: 'code.run', payload: { language: 'bash', source: 'echo x' } }).id);
  queue.start();
  try {
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('queue did not drain in time')), 20_000);
      const check = setInterval(() => {
        const done = db.all(`SELECT status FROM runs WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
          .filter((row) => ['completed', 'failed', 'cancelled', 'unverified'].includes(row.status)).length;
        if (done === ids.length) { clearInterval(check); clearTimeout(deadline); resolve(); }
      }, 10);
    });
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`[perf] rss after 50 runs: ${rssMb}MB`);
    assert.ok(rssMb < 512, `rss ${rssMb}MB must stay under 512MB`);
  } finally {
    queue.stop();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
