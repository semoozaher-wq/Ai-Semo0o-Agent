import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { DistributedRateLimiter } from '../security/http.mjs';
import { normalizeModelId, modelProvider } from '../models/catalog.mjs';

test('model contract normalizes UI aliases and rejects unsupported IDs', () => {
  assert.equal(normalizeModelId('gemini-3-flash'), 'gemini-3-flash-preview');
  assert.equal(modelProvider('claude-4.5-sonnet'), 'anthropic');
  assert.throws(() => normalizeModelId('not-a-real-model'), /UNSUPPORTED_MODEL/);
});

test('distributed limiter shares a fixed window through SQLite', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-limit-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  try {
    const limiter = new DistributedRateLimiter(db, { windowMs: 60_000, max: 2 });
    assert.equal(limiter.allow('same-client'), true);
    assert.equal(limiter.allow('same-client'), true);
    assert.equal(limiter.allow('same-client'), false);
    assert.equal(limiter.allow('other-client'), true);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
