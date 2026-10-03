import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AgentPackageStore,
  PersistentVectorStore,
  PlatformStore,
  ProjectMemory,
  TaskGraph,
  buildProjectIntelligence,
  chunkText,
  executeTaskGraph,
  rerank,
} from '../phase2-core/platform.mjs';
import { BrowserAgent } from '../phase2-core/browser-agent.mjs';

const temp = async () => mkdtemp(path.join(os.tmpdir(), 'semo0o-phase2-'));

test('dynamic planner builds a validated DAG and parallel executor respects conflicts', async () => {
  const graph = TaskGraph.fromGoal('build and verify browser project');
  assert.ok(graph.nodes.length >= 5);
  const running = [];
  const result = await executeTaskGraph(graph, async (node) => {
    running.push(node.kind);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { node: node.id };
  });
  assert.equal(result.ok, true);
  assert.ok(result.events.some((event) => event.type === 'started'));
  assert.equal(graph.nodes.every((node) => node.status === 'completed'), true);
  assert.ok(running.includes('browser'));
});

test('executor replans once and reports failed attempts', async () => {
  const graph = new TaskGraph('recovery', [{ id: 'a', title: 'flaky', writes: ['x'] }]);
  let calls = 0;
  const result = await executeTaskGraph(graph, async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient');
    return 'ok';
  }, { maxAttempts: 2, replan: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(result.events.filter((event) => event.type === 'replanned').length, 1);
});

test('project intelligence creates symbols, imports, dependency graph and test mapping', async () => {
  const root = await temp();
  await writeFile(path.join(root, 'a.ts'), "import { b } from './b'; export function a() { return b(); }\n");
  await writeFile(path.join(root, 'b.ts'), 'export const b = () => 1;\n');
  await writeFile(path.join(root, 'a.test.ts'), "import { a } from './a'; test('a', () => a());\n");
  const result = await buildProjectIntelligence(root);
  assert.ok(result.symbols.some((symbol) => symbol.name === 'a'));
  assert.ok(result.imports.some((item) => item.specifier === './b'));
  assert.ok(result.importGraph.some((edge) => edge.from === 'a.ts'));
  assert.ok(result.testMapping.some((item) => item.test.endsWith('a.test.ts')));
  assert.equal(result.parser, 'typescript-ast');
  assert.ok(result.symbols.some((symbol) => symbol.parser === 'typescript-ast'));
});

test('RAG chunks, persists vectors, retrieves and reranks', async () => {
  const root = await temp();
  const store = await new PersistentVectorStore(path.join(root, 'vectors.json')).load();
  assert.equal(chunkText('a'.repeat(100), { size: 25, overlap: 5 }).length, 5);
  await store.replaceDocuments([{ id: 'doc', text: 'terminal permissions and safe workspace writes', metadata: { source: 'security.md' } }]);
  const results = store.query('workspace permissions', 3);
  assert.equal(results.length, 1);
  assert.ok(rerank('workspace permissions', results)[0].rerankScore >= results[0].score);
  const restored = await new PersistentVectorStore(path.join(root, 'vectors.json')).load();
  assert.equal(restored.records.length, 1);
});

test('persistent memory stores failures and recalls previous fixes', async () => {
  const root = await temp();
  const memory = await new ProjectMemory(path.join(root, 'memory.json')).load();
  await memory.record('failure', { taskId: 't1', message: 'typecheck failed', fix: 'repair import path' });
  const restored = await new ProjectMemory(path.join(root, 'memory.json')).load();
  assert.equal(restored.data.failures.length, 1);
  assert.equal(restored.recall('import path').length, 1);
});

test('platform store persists entities, usage and hashes API keys', async () => {
  const root = await temp();
  const store = await new PlatformStore(path.join(root, 'platform.json')).load();
  const user = await store.create('users', { email: 'user@example.test' });
  const run = await store.create('runs', { userId: user.id, status: 'running' });
  await store.appendLog(run.id, 'info', 'started');
  await store.recordUsage(run.id, 10, 5);
  const key = await store.storeApiKey(user.id, 'openai', 'secret-value-123');
  assert.equal(key.secretHash.length, 64);
  assert.equal(key.secret, undefined);
  const persisted = JSON.parse(await readFile(path.join(root, 'platform.json'), 'utf8'));
  assert.equal(persisted.usage[0].totalTokens, 15);
});

test('agent package store enforces permissions, dependencies and rollback', async () => {
  const root = await temp();
  const store = await new AgentPackageStore(path.join(root, 'packages.json')).load();
  await store.install({ name: 'base', version: '1.0.0', permissions: [] });
  await assert.rejects(() => store.install({ name: 'browser', version: '1.0.0', dependencies: ['base'], permissions: ['browser'] }), /PACKAGE_PERMISSION_REQUIRED/);
  await store.install({ name: 'browser', version: '1.0.0', dependencies: ['base'], permissions: ['browser'] }, { permissions: ['browser'] });
  await store.install({ name: 'browser', version: '1.1.0', dependencies: ['base'], permissions: ['browser'] }, { permissions: ['browser'] });
  const old = await store.rollback('browser');
  assert.equal(old.version, '1.0.0');
  assert.equal(await store.uninstall('browser'), true);
});

test('browser agent requires an explicit CDP connection and exposes verification API', () => {
  assert.throws(() => new BrowserAgent(''), /BROWSER_CDP_URL_REQUIRED/);
  const browser = new BrowserAgent('ws://127.0.0.1:9222/devtools/page/test');
  assert.equal(typeof browser.verify, 'function');
  assert.deepEqual(browser.evidence().events, []);
});
