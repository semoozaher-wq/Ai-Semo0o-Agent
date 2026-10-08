import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Database, id, now } from '../db/client.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { readDocx, readPptx, readXlsx } from '../authoring/office.mjs';
import { ArtifactStore } from '../artifacts/store.mjs';

/**
 * Office authoring tools, end to end through the LIVE registry: the agent calls
 * docx.create / xlsx.edit / ... and gets real files in the workspace plus a row
 * in the durable artifact ledger. Nothing is asserted from a flag.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-authoring-tools-'));

function seedRun(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  const runId = id('run');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'T', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'a@t', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'P', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'g', 'running', t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'running', '{}', 0, t, t);
  return { runId };
}

test('docx.create + docx.edit produce a real document and record artifacts', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'a.sqlite'));
    const { runId } = seedRun(db);
    const registry = createLiveToolRegistry({ db, getWorkspaceRoot: () => dir });
    const context = { workspaceRoot: dir, run: { id: runId } };

    const created = await registry.run('docx.create', {
      path: 'docs/report.docx',
      title: 'Report',
      paragraphs: ['First line', { text: 'Details', style: 'Heading1' }],
    }, context);
    assert.equal(created.output.path, 'docs/report.docx');
    assert.ok(created.output.bytes > 0);
    assert.ok(created.output.artifact?.id, 'artifact recorded');
    const doc = await readDocx(await readFile(path.join(dir, 'docs/report.docx')));
    assert.equal(doc.title, 'Report');
    assert.equal(doc.paragraphs.length, 3);

    const edited = await registry.run('docx.edit', {
      path: 'docs/report.docx',
      operations: [{ op: 'append', text: 'appended' }, { op: 'replace', match: 'First line', text: 'First line (edited)' }],
    }, context);
    assert.equal(edited.output.path, 'docs/report.docx');
    const doc2 = await readDocx(await readFile(path.join(dir, 'docs/report.docx')));
    assert.equal(doc2.paragraphs.at(-1).text, 'appended');
    assert.ok(doc2.paragraphs.some((p) => p.text === 'First line (edited)'));

    // The ledger now holds two artifacts for this run.
    const store = new ArtifactStore(db);
    assert.equal(store.count(runId), 2);
    const rows = store.list(runId);
    assert.equal(rows[0].mime_type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pptx.create and xlsx.create work through the registry', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'a.sqlite'));
    const { runId } = seedRun(db);
    const registry = createLiveToolRegistry({ db, getWorkspaceRoot: () => dir });
    const context = { workspaceRoot: dir, run: { id: runId } };

    await registry.run('pptx.create', { path: 'decks/pitch.pptx', slides: [{ title: 'Intro', bullets: ['a', 'b'] }, { title: 'Ask', bullets: ['$$'] }] }, context);
    const deck = await readPptx(await readFile(path.join(dir, 'decks/pitch.pptx')));
    assert.equal(deck.slides.length, 2);
    assert.equal(deck.slides[1].title, 'Ask');

    await registry.run('xlsx.create', { path: 'sheets/budget.xlsx', sheets: [{ name: 'Q1', rows: [['Item', 'Amt'], ['Rent', 1200], [{ value: 'Total', style: 'Bold' }, { value: 0, formula: 'SUM(B2:B2)' }]] }] }, context);
    const book = await readXlsx(await readFile(path.join(dir, 'sheets/budget.xlsx')));
    assert.equal(book.sheets[0].name, 'Q1');
    assert.equal(book.sheets[0].rows[1][1], 1200);
    assert.equal(book.sheets[0].rows[2][1].formula, 'SUM(B2:B2)');

    const store = new ArtifactStore(db);
    assert.equal(store.count(runId), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('office tools are registered as live and reject malformed args', async () => {
  const registry = createLiveToolRegistry();
  const status = registry.status();
  for (const id of ['docx.create', 'docx.edit', 'odt.create', 'odt.edit', 'pptx.create', 'pptx.edit', 'xlsx.create', 'xlsx.edit']) {
    assert.ok(status.live.includes(id), `${id} should be live`);
    assert.ok(registry.has(id));
  }
  // Safe-mode schema validation rejects a wrong-typed argument up front.
  await assert.rejects(() => registry.run('docx.create', { path: 123 }), /TOOL_ARGS_INVALID/);
});
