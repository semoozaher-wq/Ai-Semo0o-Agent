import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

// Regression tests for a real bug: `workspacePath()` is async, but three tools
// (data.profile, pdf.extract, code.analyze) called it WITHOUT `await`. They
// therefore destructured a Promise, received `{ resolved: undefined }`, and
// passed `undefined` to readFile/pdftotext — a guaranteed runtime failure that no
// existing test caught because none exercised these tools end to end.
//
// These tests call the tools for real and assert on their output, so a missing
// `await` (or any path-resolution regression) fails loudly.

const MINIMAL_PDF = [
  '%PDF-1.4',
  '1 0 obj',
  '<< /Type /Catalog /Pages 2 0 R >>',
  'endobj',
  '2 0 obj',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  'endobj',
  '3 0 obj',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  'endobj',
  '4 0 obj',
  '<< /Length 44 >>',
  'stream',
  'BT /F1 24 Tf 100 700 Td (Hello PDF World) Tj ET',
  'endstream',
  'endobj',
  '5 0 obj',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  'endobj',
  'trailer',
  '<< /Root 1 0 R >>',
  '%%EOF',
  '',
].join('\n');

// `pdf.extract` shells out to poppler's `pdftotext`. CI installs poppler-utils,
// but the binary is optional in other environments, so this regression test
// (which targets the missing-`await` bug, not poppler itself) skips cleanly when
// the binary is unavailable instead of failing the whole suite.
const PDFTOTEXT_AVAILABLE = !spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).error;

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-tools-await-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const tools = createLiveToolRegistry({ db, getWorkspaceRoot: () => dir });
  await writeFile(path.join(dir, 'notes.txt'), '// TODO fix this\nconsole.log("debug");\nconst api_key = "secret-value";\n');
  await writeFile(path.join(dir, 'data.csv'), 'name,age\nAda,36\nGrace,45\n');
  await writeFile(path.join(dir, 'mini.pdf'), MINIMAL_PDF, 'latin1');
  return {
    dir, db, tools,
    close: async () => { db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('code.analyze resolves its path and reports real issues (regression: missing await)', async () => {
  const fx = await fixture();
  try {
    const result = await fx.tools.run('code.analyze', { path: 'notes.txt' }, { workspaceRoot: fx.dir });
    assert.equal(result.output.path, 'notes.txt');
    assert.equal(result.output.healthy, false);
    const rules = new Set(result.output.issues.map((issue) => issue.rule));
    assert.ok(rules.has('todo-comment'), 'expected todo-comment rule');
    assert.ok(rules.has('no-console'), 'expected no-console rule');
    assert.ok(rules.has('hardcoded-secret'), 'expected hardcoded-secret rule');
  } finally { await fx.close(); }
});

test('data.profile resolves its path and profiles a CSV (regression: missing await)', async () => {
  const fx = await fixture();
  try {
    const result = await fx.tools.run('data.profile', { path: 'data.csv' }, { workspaceRoot: fx.dir });
    assert.equal(result.output.path, 'data.csv');
    assert.equal(result.output.profile.format, 'csv');
    assert.equal(result.output.profile.rows, 2);
    assert.deepEqual(result.output.profile.columns.map((column) => column.name), ['name', 'age']);
  } finally { await fx.close(); }
});

test('pdf.extract resolves its path and extracts text (regression: missing await)', { skip: PDFTOTEXT_AVAILABLE ? false : 'pdftotext (poppler-utils) not installed' }, async () => {
  const fx = await fixture();
  try {
    const result = await fx.tools.run('pdf.extract', { path: 'mini.pdf' }, { workspaceRoot: fx.dir });
    assert.equal(result.output.path, 'mini.pdf');
    assert.match(result.output.text, /Hello PDF World/);
  } finally { await fx.close(); }
});

test('the fixed tools still reject path traversal out of the workspace', async () => {
  const fx = await fixture();
  try {
    for (const toolId of ['code.analyze', 'data.profile', 'pdf.extract']) {
      await assert.rejects(
        () => fx.tools.run(toolId, { path: '../../etc/passwd' }, { workspaceRoot: fx.dir }),
        /PATH_OUTSIDE_WORKSPACE|PATH_INVALID|PATH_TRAVERSAL|ABSOLUTE_PATH/,
        `${toolId} must reject traversal`,
      );
    }
  } finally { await fx.close(); }
});
