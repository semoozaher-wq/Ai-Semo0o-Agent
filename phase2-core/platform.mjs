import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const id = (prefix) => `${prefix}_${randomUUID()}`;
const now = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`PERSISTENCE_INVALID_JSON:${file}`, { cause: error });
    }
    throw error;
  }
}

async function writeJsonAtomically(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/* ----------------------------- Dynamic Planner ---------------------------- */

export class TaskGraph {
  constructor(goal, nodes = []) {
    this.id = id('graph');
    this.goal = goal;
    this.nodes = nodes.map((node, index) => ({
      id: node.id ?? id('node'),
      title: node.title,
      kind: node.kind ?? 'task',
      dependsOn: [...new Set(node.dependsOn ?? [])],
      reads: [...new Set(node.reads ?? [])],
      writes: [...new Set(node.writes ?? [])],
      run: node.run,
      status: 'pending',
      index,
      attempts: 0,
    }));
    this.validate();
  }

  validate() {
    const ids = new Set(this.nodes.map((node) => node.id));
    for (const node of this.nodes) {
      for (const dependency of node.dependsOn) {
        if (!ids.has(dependency)) throw new Error(`GRAPH_MISSING_DEPENDENCY:${node.id}:${dependency}`);
      }
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (nodeId) => {
      if (visiting.has(nodeId)) throw new Error(`GRAPH_CYCLE:${nodeId}`);
      if (visited.has(nodeId)) return;
      visiting.add(nodeId);
      const node = this.nodes.find((item) => item.id === nodeId);
      node.dependsOn.forEach(visit);
      visiting.delete(nodeId);
      visited.add(nodeId);
    };
    this.nodes.forEach((node) => visit(node.id));
    return this;
  }

  ready() {
    const complete = new Set(this.nodes.filter((node) => node.status === 'completed').map((node) => node.id));
    return this.nodes.filter((node) => node.status === 'pending' && node.dependsOn.every((dependency) => complete.has(dependency)));
  }

  static fromGoal(goal, context = {}) {
    const text = String(goal).toLowerCase();
    const nodes = [];
    const add = (title, kind, options = {}) => {
      const node = { id: options.id ?? id('node'), title, kind, ...options };
      delete node.run;
      nodes.push(node);
      return node.id;
    };
    const inspect = add('فحص المشروع وبناء خريطة الرموز', 'intelligence', { reads: ['workspace'], writes: ['index'] });
    const plan = add('تحويل الهدف إلى خطة تنفيذ قابلة للتحقق', 'planning', { dependsOn: [inspect], reads: ['index'], writes: ['task-graph'] });
    const implement = add('تنفيذ التغييرات الآمنة', 'implementation', { dependsOn: [plan], reads: ['workspace', 'task-graph'], writes: ['workspace'] });
    const verify = add('تشغيل الاختبارات والتحقق من الأدلة', 'verification', { dependsOn: [implement], reads: ['workspace'], writes: ['evidence'] });
    if (/browser|متصفح|موقع|واجهة/.test(text)) add('التحقق من المتصفح والصفحة', 'browser', { dependsOn: [verify], reads: ['browser'], writes: ['evidence'] });
    if (/search|بحث|rag|ذاكرة|memory|وثائق/.test(text)) add('استرجاع السياق من ذاكرة المشروع', 'retrieval', { dependsOn: [inspect], reads: ['rag'], writes: ['context'] });
    // Delivery node: only for goals that explicitly ask to ship the change
    // (branch / commit / PR / CI / merge). It depends on verification so a PR is
    // never opened before the change has been verified.
    if (/pull request|\bpr\b|github|commit|\bci\b|deliver|تسليم|فرع|دمج|طلب دمج|التزام/.test(text)) add('تسليم التغييرات (فرع/PR/CI)', 'delivery', { dependsOn: [verify], reads: ['workspace', 'evidence'], writes: ['delivery'] });
    const finalDeps = nodes.filter((node) => ['browser', 'retrieval', 'verification', 'delivery'].includes(node.kind)).map((node) => node.id);
    add('تجميع التقرير النهائي', 'report', { dependsOn: finalDeps.length ? finalDeps : [verify], reads: ['evidence', 'context'], writes: ['report'] });
    return new TaskGraph(goal, nodes);
  }

  /**
   * Dynamic, model-driven decomposition. Produces the SAME TaskGraph shape as
   * `fromGoal` (identical node kinds, so the same specialist roles apply), but
   * derives the node list from the goal itself instead of fixed keyword
   * heuristics. It is strictly additive and safe:
   *
   *   - no model  -> `fromGoal` (deterministic baseline, never worse);
   *   - model error / unparseable output / invalid DAG (cycle, missing dep,
   *     empty) -> `fromGoal`;
   *   - a valid model plan -> a TaskGraph built from it (still validated by the
   *     constructor, so a bad graph can never escape).
   *
   * The returned graph carries `planSource` ('model' | 'heuristic') so callers
   * can surface which planner produced the plan.
   *
   * @param {string} goal
   * @param {object} [context]
   * @param {object} [options] { llm, model, signal, maxNodes }
   * @returns {Promise<TaskGraph>}
   */
  static async decompose(goal, context = {}, options = {}) {
    const { llm, model, signal, maxNodes = 12 } = options;
    const fallback = () => {
      const graph = TaskGraph.fromGoal(goal, context);
      graph.planSource = 'heuristic';
      return graph;
    };
    if (!llm || typeof llm.complete !== 'function') return fallback();
    let text;
    try {
      const response = await llm.complete({
        model,
        messages: [
          { role: 'system', content: DECOMPOSITION_SYSTEM_PROMPT },
          { role: 'user', content: buildDecompositionPrompt(goal, context, maxNodes) },
        ],
        signal,
      });
      text = typeof response === 'string' ? response : response?.text;
    } catch {
      return fallback();
    }
    const nodes = parseDecomposition(text, maxNodes);
    if (!nodes) return fallback();
    try {
      const graph = new TaskGraph(goal, nodes);
      graph.planSource = 'model';
      return graph;
    } catch {
      return fallback();
    }
  }
}

const DECOMPOSITION_KINDS = Object.freeze(['intelligence', 'planning', 'implementation', 'verification', 'browser', 'retrieval', 'delivery', 'report', 'task']);

const DECOMPOSITION_SYSTEM_PROMPT = [
  'You are a planning engine that decomposes a software goal into a small DAG of executable sub-tasks.',
  'Return ONLY a JSON object, no prose and no markdown fences, of the exact shape:',
  '{"nodes":[{"id":"short-id","title":"imperative title","kind":"<kind>","dependsOn":["other-id"],"reads":["resource"],"writes":["resource"]}]}',
  `"kind" MUST be one of: ${DECOMPOSITION_KINDS.join(', ')}.`,
  'Rules: ids are unique short slugs; dependsOn references existing ids only; the graph MUST be acyclic; include a single terminal "report" node that depends on the other leaf nodes; keep it under 12 nodes; be concrete and specific to the goal.',
].join(' ');

function buildDecompositionPrompt(goal, context, maxNodes) {
  const hints = Array.isArray(context?.hints) ? context.hints.slice(0, 20) : [];
  const notes = Array.isArray(context?.notes) ? context.notes.slice(0, 20) : [];
  return JSON.stringify({ goal: String(goal ?? ''), maxNodes, hints, notes });
}

/**
 * Extract and normalize a decomposition JSON object from model text. Returns a
 * node array ready for the TaskGraph constructor, or null when the text carries
 * no usable plan (so the caller can fall back to the heuristic planner).
 */
function parseDecomposition(text, maxNodes) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  const rawNodes = Array.isArray(parsed) ? parsed : parsed?.nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return null;
  const limit = Math.max(1, Math.min(Number(maxNodes) || 12, 32));
  const chosen = rawNodes.slice(0, limit);
  const slug = (value, fallback) => {
    const base = String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return base || fallback;
  };
  const nodes = [];
  const idByIndex = new Map();
  const idByTitle = new Map();
  chosen.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const fallbackId = `node-${index + 1}`;
    let nodeId = slug(raw.id ?? raw.title, fallbackId);
    let unique = nodeId;
    let counter = 2;
    while (nodes.some((node) => node.id === unique)) unique = `${nodeId}-${counter++}`;
    nodeId = unique;
    const kind = DECOMPOSITION_KINDS.includes(raw.kind) ? raw.kind : 'task';
    const title = String(raw.title ?? raw.id ?? `Step ${index + 1}`).slice(0, 200);
    const node = {
      id: nodeId,
      title,
      kind,
      dependsOn: [],
      reads: Array.isArray(raw.reads) ? raw.reads.map((item) => String(item)).slice(0, 20) : [],
      writes: Array.isArray(raw.writes) ? raw.writes.map((item) => String(item)).slice(0, 20) : [],
      __rawDeps: Array.isArray(raw.dependsOn) ? raw.dependsOn : [],
    };
    idByIndex.set(index, nodeId);
    if (!idByTitle.has(title.toLowerCase())) idByTitle.set(title.toLowerCase(), nodeId);
    nodes.push(node);
  });
  if (nodes.length === 0) return null;
  // Resolve dependencies by id, by title, or by 0-based/1-based index.
  for (const node of nodes) {
    const resolved = [];
    for (const dep of node.__rawDeps) {
      let target = null;
      if (typeof dep === 'number' && Number.isInteger(dep)) {
        target = idByIndex.get(dep) ?? idByIndex.get(dep - 1) ?? null;
      } else {
        const value = String(dep).trim();
        const byId = nodes.find((candidate) => candidate.id === value || candidate.id === slug(value, value));
        const byTitle = idByTitle.get(value.toLowerCase());
        target = byId?.id ?? byTitle ?? null;
      }
      if (target && target !== node.id && !resolved.includes(target)) resolved.push(target);
    }
    delete node.__rawDeps;
    node.dependsOn = resolved;
  }
  // If the model forgot to wire the terminal report node, attach it to the
  // current leaves so the DAG stays honest (never invents a cycle: the report
  // node is terminal by construction here).
  const reportNode = nodes.find((node) => node.kind === 'report');
  if (reportNode && reportNode.dependsOn.length === 0) {
    const dependedOn = new Set(nodes.flatMap((node) => node.dependsOn));
    const leaves = nodes.filter((node) => node.id !== reportNode.id && !dependedOn.has(node.id));
    reportNode.dependsOn = leaves.map((node) => node.id);
  }
  return nodes;
}

function conflict(a, b) {
  const writesA = new Set(a.writes);
  const writesB = new Set(b.writes);
  return a.writes.some((resource) => writesB.has(resource)) || a.writes.some((resource) => b.reads.includes(resource)) || b.writes.some((resource) => a.reads.includes(resource));
}

/**
 * Deterministic reconciliation summary for a TaskGraph after execution. It turns
 * the per-node terminal states into a single machine-readable verdict (counts,
 * failed/pending node ids, and whether every completed node actually produced a
 * result). This is what lets a caller reconcile the team's outcomes instead of
 * trusting the first node that happened to finish.
 */
export function summarizeTaskGraph(graph) {
  const nodes = (graph?.nodes ?? []).map((node) => ({
    id: node.id,
    kind: node.kind,
    status: node.status,
    attempts: node.attempts,
    hasResult: node.result !== undefined && node.result !== null,
    ...(node.error ? { error: node.error } : {}),
  }));
  const completed = nodes.filter((node) => node.status === 'completed');
  const failed = nodes.filter((node) => node.status === 'failed');
  const pending = nodes.filter((node) => node.status === 'pending' || node.status === 'running');
  const missingResults = completed.filter((node) => !node.hasResult).map((node) => node.id);
  return {
    total: nodes.length,
    completed: completed.length,
    failed: failed.length,
    pending: pending.length,
    failedNodes: failed.map((node) => node.id),
    missingResults,
    consistent: failed.length === 0 && pending.length === 0 && missingResults.length === 0,
    nodes,
  };
}

export async function executeTaskGraph(graph, runner, options = {}) {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  // Bounded parallelism: cap how many independent nodes may run at once. The
  // default is unbounded, so existing callers keep the exact previous behaviour;
  // a caller (e.g. the multi-agent orchestrator) can pass `maxParallel` to keep
  // concurrency — and therefore concurrent model/tool calls — bounded.
  const maxParallel = Number.isFinite(options.maxParallel) && options.maxParallel > 0 ? Math.floor(options.maxParallel) : Infinity;
  const events = [];
  while (graph.nodes.some((node) => node.status === 'pending' || node.status === 'running')) {
    const candidates = graph.ready();
    if (!candidates.length) {
      const blocked = graph.nodes.filter((node) => node.status === 'pending');
      if (blocked.length) throw new Error(`GRAPH_BLOCKED:${blocked.map((node) => node.id).join(',')}`);
      break;
    }
    const batch = [];
    for (const candidate of candidates) {
      if (batch.length >= maxParallel) break;
      if (batch.every((running) => !conflict(candidate, running))) batch.push(candidate);
    }
    await Promise.all(batch.map(async (node) => {
      node.status = 'running';
      node.attempts += 1;
      events.push({ at: now(), type: 'started', nodeId: node.id, attempt: node.attempts });
      try {
        node.result = await runner(node, graph);
        node.status = 'completed';
        events.push({ at: now(), type: 'completed', nodeId: node.id });
      } catch (error) {
        node.error = error instanceof Error ? error.message : String(error);
        if (node.attempts < maxAttempts && options.replan) {
          node.status = 'pending';
          await options.replan(node, error, graph);
          events.push({ at: now(), type: 'replanned', nodeId: node.id, error: node.error });
        } else {
          node.status = 'failed';
          events.push({ at: now(), type: 'failed', nodeId: node.id, error: node.error });
        }
      }
    }));
    if (graph.nodes.some((node) => node.status === 'failed')) break;
  }
  return { graph, events, ok: graph.nodes.every((node) => node.status === 'completed'), summary: summarizeTaskGraph(graph) };
}

/* --------------------------- Project Intelligence ------------------------- */

const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const importPattern = /(?:import\s+(?:[^'";]+?\s+from\s+)?|export\s+[^'";]+?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
const symbolPattern = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

export async function buildProjectIntelligence(root, options = {}) {
  const files = [];
  // Additive bound: callers (e.g. the code-intelligence tools) can cap the number
  // of source files indexed so a huge workspace cannot make an index build
  // unbounded. Defaults to unbounded, so existing callers are unaffected.
  const maxFiles = Number.isFinite(options.maxFiles) && options.maxFiles > 0 ? Math.floor(options.maxFiles) : Infinity;
  let truncated = false;
  const walk = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (files.length >= maxFiles) { truncated = true; return; }
      if (['node_modules', '.git', 'dist', '.expo'].includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (codeExtensions.has(path.extname(entry.name))) files.push(full);
    }
  };
  await walk(root);
  const symbols = [];
  const imports = [];
  let ts = null;
  try { ts = await import('typescript'); } catch { /* optional runtime dependency */ }
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    const relative = path.relative(root, file);
    if (ts) {
      const scriptKind = /\.tsx?$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.JSX;
      const ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind);
      const visit = (node) => {
        if (node.name?.text && [ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.EnumDeclaration].includes(node.kind)) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          symbols.push({ name: node.name.text, file: relative, line, kind: ts.SyntaxKind[node.kind], parser: 'typescript-ast' });
        }
        if (ts.isVariableStatement(node)) {
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) symbols.push({ name: declaration.name.text, file: relative, line, kind: 'VariableDeclaration', parser: 'typescript-ast' });
          }
        }
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) imports.push({ from: relative, specifier: node.moduleSpecifier.text, parser: 'typescript-ast' });
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push({ from: relative, specifier: node.moduleSpecifier.text, parser: 'typescript-ast' });
        ts.forEachChild(node, visit);
      };
      visit(ast);
      continue;
    }
    let match;
    while ((match = symbolPattern.exec(source))) symbols.push({ name: match[1], file: relative, line: source.slice(0, match.index).split('\n').length });
    symbolPattern.lastIndex = 0;
    while ((match = importPattern.exec(source))) imports.push({ from: relative, specifier: match[1] });
    importPattern.lastIndex = 0;
  }
  for (const edge of imports) edge.resolved = await resolveImport(root, path.join(root, edge.from), edge.specifier);
  const graph = imports.filter((edge) => edge.resolved).map(({ from, resolved }) => ({ from, to: resolved }));
  const tests = files.filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)).map((file) => path.relative(root, file));
  const testMapping = tests.map((test) => ({ test, importedSources: graph.filter((edge) => edge.from === test).map((edge) => edge.to), likelySources: graph.filter((edge) => edge.from === test).map((edge) => edge.to) }));
  return { generatedAt: now(), root, files: files.map((file) => path.relative(root, file)), symbols, imports, importGraph: graph, dependencyGraph: graph, testMapping, parser: ts ? 'typescript-ast' : 'lexical-fallback', truncated };
}

async function resolveImport(root, importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  for (const suffix of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
    const absolute = base + suffix;
    try {
      const stat = await fs.stat(absolute);
      const candidate = path.relative(root, absolute);
      if (!candidate.startsWith('..') && stat.isFile()) return candidate;
    } catch { /* continue resolution */ }
  }
  return null;
}

/* ---------------------------------- RAG ----------------------------------- */

function tokens(text) { return String(text).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []; }
function localEmbedding(text, dimensions = 64) {
  const vector = Array(dimensions).fill(0);
  for (const token of tokens(text)) {
    const hash = parseInt(sha256(token).slice(0, 8), 16);
    vector[hash % dimensions] += 1;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
}
function cosine(a, b) { return a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0); }

export function chunkText(text, options = {}) {
  const size = options.size ?? 800;
  const overlap = Math.min(options.overlap ?? 120, size - 1);
  const chunks = [];
  for (let start = 0; start < text.length; start += size - overlap) chunks.push({ text: text.slice(start, start + size), start, end: Math.min(text.length, start + size) });
  return chunks;
}

export class PersistentVectorStore {
  constructor(file, options = {}) { this.file = file; this.records = []; this.embed = options.embed ?? ((text) => localEmbedding(text)); }
  async load() { this.records = await readJson(this.file, []); return this; }
  async save() { await writeJsonAtomically(this.file, this.records); }
  async replaceDocuments(documents) {
    this.records = await Promise.all(documents.flatMap((document) => chunkText(document.text).map(async (chunk, index) => ({ id: `${document.id}:${index}`, documentId: document.id, metadata: document.metadata ?? {}, ...chunk, vector: await this.embed(chunk.text) }))));
    await this.save();
    return this.records.length;
  }
  async query(query, limit = 5) {
    const q = await this.embed(query);
    return this.records.map((record) => ({ ...record, score: cosine(q, record.vector) })).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function createRemoteEmbeddingProvider({ endpoint, apiKey, model, headers = {} }) {
  if (!endpoint) throw new Error('EMBEDDING_ENDPOINT_REQUIRED');
  return async (input) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...headers }, body: JSON.stringify({ input, model }) });
    if (!response.ok) throw new Error(`EMBEDDING_PROVIDER_${response.status}`);
    const data = await response.json();
    const vector = data.data?.[0]?.embedding ?? data.embedding;
    if (!Array.isArray(vector)) throw new Error('EMBEDDING_PROVIDER_INVALID_RESPONSE');
    return vector;
  };
}

export function rerank(query, candidates, limit = 5) {
  const queryTokens = new Set(tokens(query));
  return candidates.map((candidate) => ({ ...candidate, rerankScore: candidate.score + tokens(candidate.text).filter((token) => queryTokens.has(token)).length * 0.05 })).sort((a, b) => b.rerankScore - a.rerankScore).slice(0, limit);
}

/* ---------------------------- Persistent Memory --------------------------- */

export class ProjectMemory {
  constructor(file) { this.file = file; this.data = { project: {}, tasks: [], failures: [], context: [], history: [] }; }
  async load() { this.data = { ...this.data, ...await readJson(this.file, {}) }; return this; }
  async save() { await writeJsonAtomically(this.file, this.data); }
  async record(type, payload) { const event = { id: id('memory'), type, at: now(), ...payload }; this.data.history.push(event); if (type === 'failure') this.data.failures.push(event); if (type === 'context') this.data.context.push(event); if (type === 'task') this.data.tasks.push(event); await this.save(); return event; }
  recall(query, limit = 10) { const q = tokens(query); return this.data.history.filter((item) => q.some((token) => JSON.stringify(item).toLowerCase().includes(token))).slice(-limit).reverse(); }
}

/* ------------------------------ Platform Store ---------------------------- */

export class PlatformStore {
  constructor(file) { this.file = file; this.data = { users: [], projects: [], workspaces: [], runs: [], logs: [], usage: [], apiKeys: [], packages: [], checkpoints: [] }; }
  async load() { this.data = { ...this.data, ...await readJson(this.file, {}) }; return this; }
  async save() { await writeJsonAtomically(this.file, this.data); }
  async create(type, payload) { if (!(type in this.data)) throw new Error(`UNKNOWN_PLATFORM_ENTITY:${type}`); const item = { id: id(type.slice(0, -1)), createdAt: now(), ...payload }; this.data[type].push(item); await this.save(); return item; }
  async appendLog(runId, level, message, meta = {}) { return this.create('logs', { runId, level, message, meta, at: now() }); }
  async recordUsage(runId, inputTokens, outputTokens) { return this.create('usage', { runId, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }); }
  async storeApiKey(userId, provider, secret) { return this.create('apiKeys', { userId, provider, secretHash: sha256(secret), last4: String(secret).slice(-4) }); }
  async getRun(runId) { return this.data.runs.find((run) => run.id === runId) ?? null; }
}

/* ------------------------------ Agent Store -------------------------------- */

export class AgentPackageStore {
  constructor(file) { this.file = file; this.data = { installed: {}, history: [] }; }
  async load() { this.data = await readJson(this.file, { installed: {}, history: [] }); return this; }
  async save() { await writeJsonAtomically(this.file, this.data); }
  async install(pkg, options = {}) {
    const permissions = new Set(options.permissions ?? []);
    for (const permission of pkg.permissions ?? []) if (!permissions.has(permission)) throw new Error(`PACKAGE_PERMISSION_REQUIRED:${permission}`);
    for (const dependency of pkg.dependencies ?? []) if (!this.data.installed[dependency]) throw new Error(`PACKAGE_DEPENDENCY_MISSING:${dependency}`);
    const previous = this.data.installed[pkg.name];
    this.data.installed[pkg.name] = { ...pkg, installedAt: now() };
    this.data.history.push({ action: previous ? 'update' : 'install', name: pkg.name, previous, next: this.data.installed[pkg.name], at: now() });
    await this.save();
    return this.data.installed[pkg.name];
  }
  async uninstall(name) { const previous = this.data.installed[name]; if (!previous) return false; delete this.data.installed[name]; this.data.history.push({ action: 'uninstall', name, previous, at: now() }); await this.save(); return true; }
  async rollback(name) { const history = [...this.data.history].reverse().find((item) => item.name === name && item.previous); if (!history) throw new Error(`PACKAGE_NO_ROLLBACK:${name}`); this.data.installed[name] = history.previous; this.data.history.push({ action: 'rollback', name, next: history.previous, at: now() }); await this.save(); return this.data.installed[name]; }
}
