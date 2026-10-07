import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { MemoryStore } from '../memory/store.mjs';
import { mapWithConcurrency, resolveConcurrency } from '../util/concurrency.mjs';

test('resolveConcurrency clamps to a safe range and falls back on bad input', () => {
  assert.equal(resolveConcurrency(undefined, 4), 4);
  assert.equal(resolveConcurrency('8'), 8);
  assert.equal(resolveConcurrency(0), 4);
  assert.equal(resolveConcurrency(-3), 4);
  assert.equal(resolveConcurrency('abc'), 4);
  assert.equal(resolveConcurrency(1.5), 4);
  assert.equal(resolveConcurrency(1000), 32, 'must clamp to the hard maximum');
});

test('mapWithConcurrency never exceeds the limit and preserves input order', async () => {
  const items = Array.from({ length: 25 }, (_, index) => index);
  let inFlight = 0;
  let peak = 0;
  const results = await mapWithConcurrency(items, 4, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 3));
    inFlight -= 1;
    return item * 2;
  });
  assert.ok(peak <= 4, `peak concurrency ${peak} must not exceed the limit`);
  assert.equal(results.length, 25);
  assert.deepEqual(results.map((entry) => entry.value), items.map((item) => item * 2));
  assert.ok(results.every((entry) => entry.status === 'fulfilled'));
});

test('mapWithConcurrency collects failures without aborting the batch', async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
    if (item % 2 === 0) throw new Error(`boom-${item}`);
    return item;
  });
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.message, 'boom-2');
  assert.equal(results[2].value, 3);
  assert.equal(results[3].status, 'rejected');
});

test('mapWithConcurrency handles an empty list and a limit larger than the list', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  const results = await mapWithConcurrency([1, 2], 16, async (item) => item + 1);
  assert.deepEqual(results.map((entry) => entry.value), [2, 3]);
});

test('reindexProject embeds with bounded concurrency and reports failures honestly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-concurrency-'));
  const db = new Database(path.join(dir, 'db.sqlite'));
  try {
    const timestamp = new Date().toISOString();
    db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', 't1', 'Tenant', timestamp);
    db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', 'u1', 't1', 'owner@example.test', 'test', 'owner', timestamp);
    db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', 'p1', 't1', 'u1', 'One', timestamp);

    // Inject an embedder that records peak concurrency and fails on one document.
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    const embedder = {
      provider: 'test',
      model: 'test-embed',
      async embed(text) {
        calls += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        if (String(text).includes('poison')) throw new Error('EMBEDDING_PROVIDER_500');
        return [0.1, 0.2, 0.3];
      },
    };
    const memory = new MemoryStore(db, { embedder });
    // Insert documents directly (bypassing addDocument's embedder) so the poison
    // document only fails during the reindex pass, not at insert time.
    const insertDoc = (index, content) => {
      const id = `doc_${index}`;
      db.run('INSERT INTO documents(id,tenant_id,project_id,source,content,created_at) VALUES(?,?,?,?,?,?)', id, 't1', 'p1', `s${index}`, content, timestamp);
      db.run('INSERT INTO embeddings(id,document_id,vector_json,model,created_at) VALUES(?,?,?,?,?)', `emb_${index}`, id, JSON.stringify([0, 0, 0]), 'stale', timestamp);
    };
    for (let i = 0; i < 12; i += 1) insertDoc(i, `doc number ${i}`);
    insertDoc(99, 'poison document');

    const result = await memory.reindexProject('t1', 'p1', { concurrency: 4 });
    assert.equal(result.indexed, 12, 'the 12 healthy documents must be reindexed');
    assert.equal(result.failed, 1, 'the one failing document must be reported, not hidden');
    assert.equal(result.concurrency, 4);
    assert.ok(peak <= 4, `reindex peak concurrency ${peak} must not exceed the limit`);
    assert.ok(calls >= 13);
    // The healthy documents must actually carry the new model after reindex.
    const updated = db.get('SELECT model FROM embeddings WHERE document_id=?', 'doc_0');
    assert.equal(updated.model, 'test-embed');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
