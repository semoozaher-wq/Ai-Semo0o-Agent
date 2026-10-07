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
    const finalDeps = nodes.filter((node) => ['browser', 'retrieval', 'verification'].includes(node.kind)).map((node) => node.id);
    add('تجميع التقرير النهائي', 'report', { dependsOn: finalDeps.length ? finalDeps : [verify], reads: ['evidence', 'context'], writes: ['report'] });
    return new TaskGraph(goal, nodes);
  }
}

function conflict(a, b) {
  const writesA = new Set(a.writes);
  const writesB = new Set(b.writes);
  return a.writes.some((resource) => writesB.has(resource)) || a.writes.some((resource) => b.reads.includes(resource)) || b.writes.some((resource) => a.reads.includes(resource));
}

export async function executeTaskGraph(graph, runner, options = {}) {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
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
  return { graph, events, ok: graph.nodes.every((node) => node.status === 'completed') };
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
