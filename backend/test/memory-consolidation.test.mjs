import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { MemoryStore } from '../memory/store.mjs';
import { consolidateProjectMemory, loadConsolidatedLessons, lessonSignature, CONSOLIDATED_SOURCE } from '../memory/consolidate.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

/**
 * Memory consolidation & cross-run learning: reflections are distilled into a
 * single reusable knowledge document that the NEXT run retrieves. These tests
 * prove the signature grouping, the consolidation + idempotent upsert, the
 * recency-aware retrieval, and the registry tool wiring against real SQLite.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-consol-'));

function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  const runId = id('run');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Consol Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'c@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Consol Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'consol goal', 'completed', t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'completed', '{}', 1, t, t);
  return { tenantId, userId, projectId, workspaceId, taskId, runId };
}

function addReflection(db, { tenantId, projectId, runId, lessons, status = 'completed', at = now() }) {
  db.run(
    'INSERT INTO agent_reflections(id,tenant_id,project_id,run_id,status,summary,lessons_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id('refl'), tenantId, projectId, runId, status, 'summary', JSON.stringify(lessons), at,
  );
}

test('lessonSignature collapses equivalent lessons across runs', () => {
  assert.equal(
    lessonSignature('Tool "git.status" failed previously (boom); verify its preconditions'),
    lessonSignature('tool "git.status" failed previously (boom); verify its preconditions'),
  );
  // Numbers are normalized so a retry-count difference does not split the group.
  assert.equal(lessonSignature('Recovery re-planning was needed 2 time(s)'), lessonSignature('Recovery re-planning was needed 5 time(s)'));
  // Different lessons stay distinct.
  assert.notEqual(lessonSignature('delivery skipped'), lessonSignature('loop detected'));
});

test('consolidateProjectMemory keeps recurring + high-value lessons and writes one knowledge doc', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'c.sqlite'));
    const memory = new MemoryStore(db);
    const { tenantId, projectId, runId } = seed(db);
    addReflection(db, { tenantId, projectId, runId, lessons: ['Tool "git.status" failed previously (boom); verify its preconditions', 'Delivery was skipped (no_engine); confirm the workspace engine'] });
    addReflection(db, { tenantId, projectId, runId, lessons: ['Tool "git.status" failed previously (boom); verify its preconditions'] });

    const result = await consolidateProjectMemory({ db, memory, tenantId, projectId });
    assert.equal(result.written, true);
    assert.equal(result.reflections, 2);
    assert.equal(result.recurring, 1, 'the git.status lesson recurred across both runs');
    assert.equal(result.kept, 2, 'the recurring lesson + the high-value delivery lesson');
    assert.equal(result.source, CONSOLIDATED_SOURCE);
    assert.ok(result.documentId);

    const doc = db.get('SELECT content FROM documents WHERE id=?', result.documentId);
    assert.match(doc.content, /Consolidated lessons/);
    assert.match(doc.content, /git\.status/);
    assert.match(doc.content, /seen 2×/);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('consolidation is idempotent: a second run updates the same doc, never duplicates it', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'c.sqlite'));
    const memory = new MemoryStore(db);
    const { tenantId, projectId, runId } = seed(db);
    addReflection(db, { tenantId, projectId, runId, lessons: ['same lesson'] });
    addReflection(db, { tenantId, projectId, runId, lessons: ['same lesson'] });

    const first = await consolidateProjectMemory({ db, memory, tenantId, projectId });
    assert.equal(first.updated, false);
    const second = await consolidateProjectMemory({ db, memory, tenantId, projectId });
    assert.equal(second.updated, true);
    assert.equal(second.documentId, first.documentId);
    const count = db.get('SELECT COUNT(*) AS n FROM documents WHERE tenant_id=? AND project_id=? AND source=?', tenantId, projectId, CONSOLIDATED_SOURCE);
    assert.equal(count.n, 1);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('dryRun computes the consolidation without writing anything', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'c.sqlite'));
    const memory = new MemoryStore(db);
    const { tenantId, projectId, runId } = seed(db);
    addReflection(db, { tenantId, projectId, runId, lessons: ['a', 'a'] });
    const result = await consolidateProjectMemory({ db, memory, tenantId, projectId, dryRun: true });
    assert.equal(result.written, false);
    assert.match(result.content, /Consolidated lessons/);
    const count = db.get('SELECT COUNT(*) AS n FROM documents WHERE source=?', CONSOLIDATED_SOURCE);
    assert.equal(count.n, 0);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('loadConsolidatedLessons merges the consolidated doc with live lessons, de-duplicated and bounded', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'c.sqlite'));
    const memory = new MemoryStore(db);
    const { tenantId, projectId, runId } = seed(db);
    addReflection(db, { tenantId, projectId, runId, lessons: ['Tool "x" failed previously (e); verify', 'unique live lesson'] });
    addReflection(db, { tenantId, projectId, runId, lessons: ['Tool "x" failed previously (e); verify'] });
    await consolidateProjectMemory({ db, memory, tenantId, projectId });

    const lessons = await loadConsolidatedLessons({ db, memory, tenantId, projectId, limit: 8 });
    assert.ok(lessons.some((lesson) => /Tool "x" failed/.test(lesson)), 'consolidated lesson surfaced');
    assert.ok(lessons.some((lesson) => /unique live lesson/.test(lesson)), 'live lesson surfaced');
    assert.equal(new Set(lessons).size, lessons.length, 'no duplicates');
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('MemoryStore.upsertDocument inserts then updates by (project, source)', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'c.sqlite'));
    const memory = new MemoryStore(db);
    const { tenantId, projectId } = seed(db);
    const created = await memory.upsertDocument({ tenantId, projectId, source: 'notes', content: 'v1' });
    assert.equal(created.updated, false);
    const updated = await memory.upsertDocument({ tenantId, projectId, source: 'notes', content: 'v2' });
    assert.equal(updated.updated, true);
    assert.equal(updated.id, created.id);
    assert.equal(db.get('SELECT content FROM documents WHERE id=?', created.id).content, 'v2');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM documents WHERE source=?', 'notes').n, 1);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recency-weighted search ranks fresh knowledge above stale notes', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'c.sqlite'));
    const memory = new MemoryStore(db);
    const { tenantId, projectId } = seed(db);
    const oldDoc = await memory.addDocument({ tenantId, projectId, source: 'old', content: 'alpha deployment checklist' });
    await memory.addDocument({ tenantId, projectId, source: 'new', content: 'alpha deployment checklist' });
    db.run('UPDATE documents SET created_at=? WHERE id=?', '2020-01-01T00:00:00.000Z', oldDoc.id);

    const recency = await memory.search({ tenantId, projectId, query: 'alpha deployment checklist', limit: 5, recencyWeight: 0.5 });
    const newHit = recency.find((hit) => hit.source === 'new');
    const oldHit = recency.find((hit) => hit.source === 'old');
    assert.ok(newHit.score > oldHit.score, 'the newer doc must score higher with recency weighting');
    assert.equal(recency[0].source, 'new');
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registry: memory.consolidate is registered and runs end to end against real memory', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'c.sqlite'));
    const memory = new MemoryStore(db);
    const { tenantId, projectId, runId } = seed(db);
    addReflection(db, { tenantId, projectId, runId, lessons: ['recurring lesson'] });
    addReflection(db, { tenantId, projectId, runId, lessons: ['recurring lesson'] });

    const registry = createLiveToolRegistry({ db, codeRunner: null, tavily: null, llm: null, engineAvailable: true, memory });
    assert.ok(registry.status().tools.some((tool) => tool.id === 'memory.consolidate'), 'memory.consolidate must be in the catalog');

    const result = await registry.run('memory.consolidate', {}, { run: { tenant_id: tenantId }, task: { project_id: projectId } });
    assert.equal(result.output.kept, 1);
    assert.equal(result.output.recurring, 1);
    assert.ok(result.output.documentId);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
