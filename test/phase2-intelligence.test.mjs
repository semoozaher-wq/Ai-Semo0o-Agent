import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildProjectIntelligence } from '../phase2-core/platform.mjs';
import { analyzeImpact, buildForwardGraph, buildReverseGraph, describeImpact, normalizePath, scoreRisk } from '../phase2-core/impact.mjs';
import { buildChangeSet, describeChangeSet, parseDiff, parseStatusEntries, planVerification } from '../phase2-core/changeset.mjs';
import { CodebaseReasoner } from '../phase2-core/reasoning.mjs';
import { compareReports, defineBenchmark, evaluator, expectField, expectIncludes, expectTruthy, runBenchmark, scoreResult } from '../phase2-core/eval.mjs';
import * as phase2Engine from '../phase2-core/engine.mjs';
import * as executionEngine from '../execution-core/engine.mjs';

const temp = async () => mkdtemp(path.join(os.tmpdir(), 'semo0o-intel-'));

async function sampleProject() {
  const root = await temp();
  await writeFile(path.join(root, 'a.ts'), "import { b } from './b';\nexport function a() { return b(); }\n");
  await writeFile(path.join(root, 'b.ts'), 'export const b = () => 1;\n');
  await writeFile(path.join(root, 'c.ts'), "import { a } from './a';\nexport function c() { return a(); }\n");
  await writeFile(path.join(root, 'a.test.ts'), "import { a } from './a';\ntest('a', () => a());\n");
  return { root, intelligence: await buildProjectIntelligence(root) };
}

/* ------------------------------- impact ---------------------------------- */

test('impact: reverse/forward graphs are built from import edges', () => {
  const edges = [{ from: 'a.ts', to: 'b.ts' }, { from: 'c.ts', to: 'a.ts' }, { from: 'a.ts', to: 'a.ts' }];
  const reverse = buildReverseGraph(edges);
  const forward = buildForwardGraph(edges);
  assert.deepEqual([...reverse.get('b.ts')], ['a.ts']);
  assert.deepEqual([...forward.get('a.ts')], ['b.ts']);
  assert.equal(reverse.has('a.ts'), true);
  assert.deepEqual([...reverse.get('a.ts')].sort(), ['c.ts']);
  assert.equal(normalizePath('./x//y.ts'), 'x/y.ts');
});

test('impact: blast radius, affected tests, symbols and risk are computed', async () => {
  const { intelligence } = await sampleProject();
  const impact = analyzeImpact(intelligence, { changedFiles: ['b.ts'] });
  assert.deepEqual(impact.changedFiles, ['b.ts']);
  assert.deepEqual(impact.directDependents, ['a.ts']);
  assert.deepEqual([...impact.blastRadius].sort(), ['a.test.ts', 'a.ts', 'c.ts']);
  assert.deepEqual(impact.affectedTests, ['a.test.ts']);
  assert.ok(impact.affectedSymbols.some((symbol) => symbol.name === 'b' && symbol.relation === 'changed'));
  assert.ok(impact.affectedSymbols.some((symbol) => symbol.name === 'a' && symbol.relation === 'dependent'));
  assert.equal(impact.depth['a.ts'], 1);
  assert.equal(impact.depth['c.ts'], 2);
  assert.equal(impact.risk.level, 'medium');
  assert.ok(impact.risk.score > 0 && impact.risk.score <= 100);
  assert.match(describeImpact(impact), /risk medium/);
});

test('impact: untested change scores riskier than a tested change', () => {
  const tested = scoreRisk({ blastRadius: ['x'], affectedTests: ['x.test.ts'], maxFanIn: 1, maxDepth: 1 });
  const untested = scoreRisk({ blastRadius: ['x'], affectedTests: [], maxFanIn: 1, maxDepth: 1 });
  assert.ok(untested.score > tested.score);
  assert.equal(scoreRisk({}).level, 'low');
});

/* ------------------------------ changeset -------------------------------- */

test('changeset: parses porcelain status entries including renames and untracked', () => {
  const changes = parseStatusEntries(['## master', ' M src/a.ts', '?? src/new.ts', 'A  src/b.ts', 'R  src/old.ts -> src/renamed.ts', ' D src/gone.ts']);
  assert.equal(changes.length, 5);
  assert.deepEqual(changes.find((change) => change.path === 'src/a.ts').kind, 'modified');
  assert.deepEqual(changes.find((change) => change.path === 'src/new.ts').kind, 'untracked');
  assert.deepEqual(changes.find((change) => change.path === 'src/b.ts').kind, 'created');
  const renamed = changes.find((change) => change.kind === 'renamed');
  assert.equal(renamed.from, 'src/old.ts');
  assert.equal(renamed.path, 'src/renamed.ts');
  assert.equal(changes.find((change) => change.path === 'src/gone.ts').kind, 'deleted');
});

test('changeset: parses a unified diff into per-file statistics', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 000..111 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' const x = 1;',
    '-const y = 2;',
    '+const y = 3;',
    '+const z = 4;',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n');
  const parsed = parseDiff(diff);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 1);
  assert.equal(parsed.files.find((file) => file.path === 'src/a.ts').hunks, 1);
  assert.equal(parsed.files.find((file) => file.path === 'logo.png').binary, true);
});

test('changeset: builds a structured change set with impact and verification plan', async () => {
  const { intelligence } = await sampleProject();
  const changeSet = buildChangeSet({
    status: { entries: [' M a.ts', ' M b.ts'] },
    diff: { stdout: 'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1,2 @@\n export const b = () => 1;\n+export const b2 = () => 2;\n' },
    intelligence,
    goal: 'update b',
  });
  assert.equal(changeSet.goal, 'update b');
  assert.equal(changeSet.summary.files, 2);
  assert.equal(changeSet.summary.additions, 1);
  assert.ok(changeSet.impact);
  assert.deepEqual(changeSet.impact.affectedTests, ['a.test.ts']);
  assert.ok(changeSet.verification.steps.some((step) => step.id === 'typecheck'));
  assert.ok(changeSet.verification.steps.some((step) => step.id === 'tests' && step.tests.includes('a.test.ts')));
  assert.match(describeChangeSet(changeSet), /file\(s\)/);
});

test('changeset: verification plan flags package.json and binary changes', () => {
  const plan = planVerification([{ path: 'package.json', kind: 'modified' }, { path: 'logo.png', kind: 'modified', binary: true }], null);
  assert.ok(plan.required.includes('install'));
  assert.ok(plan.steps.some((step) => step.id === 'binary-review' && step.required === false));
});

/* ------------------------------ reasoning -------------------------------- */

test('reasoning: definition, trace, references, explain and answer over the index', async () => {
  const { root, intelligence } = await sampleProject();
  const reasoner = new CodebaseReasoner(intelligence, { read: (file) => import('node:fs/promises').then((fs) => fs.readFile(path.join(root, file), 'utf8')) });

  const definition = reasoner.definition('b');
  assert.equal(definition.matches[0].file, 'b.ts');
  assert.equal(definition.matches[0].line, 1);

  const trace = reasoner.trace('c.ts', 'b.ts');
  assert.equal(trace.reachable, true);
  assert.deepEqual(trace.path, ['c.ts', 'a.ts', 'b.ts']);
  assert.equal(reasoner.trace('b.ts', 'c.ts').reachable, false);

  const references = await reasoner.references('b');
  assert.ok(references.structural.includes('a.ts'));
  assert.ok(references.lexical.some((hit) => hit.file === 'a.ts'));

  const fileExplanation = await reasoner.explain('a.ts');
  assert.equal(fileExplanation.kind, 'file');
  assert.deepEqual(fileExplanation.imports, ['b.ts']);
  assert.deepEqual(fileExplanation.importedBy.sort(), ['a.test.ts', 'c.ts']);
  assert.deepEqual(fileExplanation.tests, ['a.test.ts']);

  const symbolExplanation = await reasoner.explain('a');
  assert.equal(symbolExplanation.kind, 'symbol');
  assert.ok(symbolExplanation.tests.includes('a.test.ts'));

  const definitionAnswer = await reasoner.answer('where is b defined');
  assert.equal(definitionAnswer.intent, 'definition');
  assert.match(definitionAnswer.answer, /b\.ts/);
  const referencesAnswer = await reasoner.answer('who uses b');
  assert.equal(referencesAnswer.intent, 'references');
  assert.match(referencesAnswer.answer, /a\.ts/);
  assert.equal((await reasoner.answer('explain a.ts')).intent, 'explain');
  assert.equal((await reasoner.answer('trace path from c.ts to b.ts')).intent, 'trace');
  assert.ok(reasoner.search('b').some((item) => item.name === 'b'));
});

/* --------------------------------- eval ---------------------------------- */

test('eval: weighted evaluators score tasks and produce a report', async () => {
  const benchmark = defineBenchmark({
    name: 'demo',
    tasks: [{ id: 't1', input: 1 }, { id: 't2', input: 2 }],
    evaluators: [
      expectField('ok', true),
      expectTruthy((result) => result.value === result.input * 2, { id: 'doubled' }),
    ],
  });
  const report = await runBenchmark(benchmark, async (task) => ({ ok: task.id === 't1', value: task.id === 't1' ? task.input * 2 : 999, input: task.input }));
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.passed, 1);
  assert.equal(report.tasks.find((task) => task.id === 't1').score, 100);
  assert.ok(report.tasks.find((task) => task.id === 't2').score < 100);
  assert.equal(report.summary.byEvaluator['field:ok'].passed, 1);
});

test('eval: runner errors are captured and evaluators can be async', async () => {
  const benchmark = defineBenchmark({ name: 'errors', tasks: [{ id: 'boom' }], evaluators: [evaluator('async', async () => ({ passed: true, detail: 'async ok' }))] });
  const report = await runBenchmark(benchmark, async () => { throw new Error('kaboom'); });
  assert.equal(report.tasks[0].ok, false);
  assert.match(report.tasks[0].error, /kaboom/);
  assert.equal(report.tasks[0].evaluators[0].passed, false);

  const scored = await scoreResult('abc', [expectIncludes('z'), expectField('length', 3)]);
  assert.equal(scored.score, 50);
  assert.equal(scored.passed, false);
});

test('eval: compareReports detects regressions and improvements', async () => {
  const make = (values) => runBenchmark(
    defineBenchmark({ name: 'cmp', tasks: values.map((value, index) => ({ id: `t${index}` })), evaluators: [expectField('ok', true)] }),
    async (task) => ({ ok: values[Number(task.id.slice(1))] }),
  );
  const comparison = compareReports(await make([true, true]), await make([true, false]));
  assert.equal(comparison.regressed, true);
  assert.ok(comparison.delta < 0);
  assert.equal(comparison.regressions.length, 1);
});

/* ------------------------------ engine shim ------------------------------ */

test('phase2-core/engine.mjs is a re-export shim over the single canonical engine', () => {
  assert.equal(phase2Engine.AgentExecutionEngine, executionEngine.AgentExecutionEngine);
  assert.equal(phase2Engine.RealGit, executionEngine.RealGit);
  assert.equal(phase2Engine.RealWorkspace, executionEngine.RealWorkspace);
  assert.equal(phase2Engine.TerminalSandbox, executionEngine.TerminalSandbox);
  assert.equal(phase2Engine.PermissionGateway, executionEngine.PermissionGateway);
  assert.equal(phase2Engine.EvidenceStore, executionEngine.EvidenceStore);
  assert.equal(phase2Engine.createExecutionEngine, executionEngine.createExecutionEngine);
  assert.equal(phase2Engine.Capability, executionEngine.Capability);
});
