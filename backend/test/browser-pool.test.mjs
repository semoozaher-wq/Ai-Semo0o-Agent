import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserPool } from '../browser/pool.mjs';

test('browser pool bounds concurrency and closes every leased browser', async () => {
  let active = 0; let peak = 0; let closed = 0;
  const pool = new BrowserPool({ maxConcurrent: 2, maxQueued: 4, createAgent: () => ({
    async connect() { active += 1; peak = Math.max(peak, active); },
    async close() { active -= 1; closed += 1; },
  }) });
  const jobs = Array.from({ length: 5 }, (_, index) => pool.run('wss://example.test', async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return index; }));
  assert.deepEqual((await Promise.all(jobs)).sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.equal(closed, 5);
  assert.deepEqual(pool.status(), { active: 0, queued: 0, maxConcurrent: 2, maxQueued: 4 });
});

test('browser pool rejects excess queued work instead of growing without bound', async () => {
  const pool = new BrowserPool({ maxConcurrent: 1, maxQueued: 1, createAgent: () => ({ async connect() {}, async close() {} }) });
  let release;
  const first = pool.run('wss://example.test', () => new Promise((resolve) => { release = resolve; }));
  const second = pool.run('wss://example.test', async () => 'second');
  await assert.rejects(() => pool.run('wss://example.test', async () => 'third'), /BROWSER_POOL_QUEUE_FULL/);
  release('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
});
