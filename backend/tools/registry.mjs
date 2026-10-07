import { readFile, writeFile, readdir, stat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createTavilySearchTool } from '../../execution-core/tavily-search.mjs';
import { createEngineToolHandlers } from '../../execution-core/engine-tools.mjs';
import { createCodeRunHandler } from '../runners/code-runner.mjs';
import { BrowserPool } from '../browser/pool.mjs';
import { runBrowserTask } from '../browser/runner.mjs';
import { assertSafeUrlResolved, assertWorkspacePath } from '../security/validators.mjs';
import { DANGEROUS_TOOLS, TOOL_BY_ID, TOOL_CATALOG } from '../agent/catalog.mjs';

function bounded(value, max, name) {
  const text = String(value ?? '');
  if (!text || text.length > max) throw new Error(`${name}_OUT_OF_RANGE`);
  return text;
}
// Resolve the real (symlink-free) path of the nearest existing ancestor and append
// the not-yet-existing tail. Used to reject symlink escapes before any file I/O.
async function realpathSafe(target) {
  const resolved = path.resolve(target);
  const tail = [];
  let current = resolved;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length ? path.join(real, ...tail) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}
async function workspacePath(root, relative) {
  const safe = assertWorkspacePath(relative);
  const base = await realpathSafe(root);
  const resolved = path.resolve(base, safe);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error('PATH_OUTSIDE_WORKSPACE');
  const real = await realpathSafe(resolved);
  if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw new Error('PATH_OUTSIDE_WORKSPACE');
  return { safe, resolved: real };
}
async function fetchText(args) {
  const url = await assertSafeUrlResolved(args.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'Semo0o-Agent/1.0' } });
    if (!response.ok) throw new Error(`WEB_SCRAPE_HTTP_${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/') && !contentType.includes('json') && !contentType.includes('xml')) throw new Error('WEB_SCRAPE_UNSUPPORTED_CONTENT');
    return { url: url.toString(), content: (await response.text()).replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, Math.min(Number(args.maxChars ?? 30000), 50000)) };
  } finally { clearTimeout(timer); }
}
async function listFiles(root, scope = '', maxFiles = 500) {
  const start = (await workspacePath(root, scope || '.')).resolved;
  const output = [];
  async function visit(dir, relative) {
    if (output.length >= maxFiles) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.expo') continue;
      if (entry.isSymbolicLink()) continue; // never follow symlinks out of the workspace
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full, nextRelative);
      else { const info = await stat(full); output.push({ path: nextRelative, sizeBytes: info.size }); }
      if (output.length >= maxFiles) return;
    }
  }
  await visit(start, scope.replace(/^\.\/?/, ''));
  return output;
}
function runPdfText(file, maxChars) {
  return new Promise((resolve, reject) => {
    const child = spawn('pdftotext', ['-layout', file, '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (out.length > maxChars) child.kill('SIGTERM'); });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 || out ? resolve(out.slice(0, maxChars)) : reject(new Error(err || 'PDF_EXTRACT_FAILED')));
  });
}
function profile(content, file) {
  const isCsv = file.toLowerCase().endsWith('.csv');
  if (isCsv) {
    const rows = content.split(/\r?\n/).filter(Boolean).slice(0, 10000).map((line) => line.split(','));
    const headers = rows.shift() ?? [];
    return { format: 'csv', rows: rows.length, columns: headers.map((name, index) => ({ name, nonEmpty: rows.filter((row) => row[index] !== '').length })) };
  }
  const value = JSON.parse(content);
  const rows = Array.isArray(value) ? value : [value];
  const keys = [...new Set(rows.flatMap((row) => row && typeof row === 'object' ? Object.keys(row) : []))];
  return { format: 'json', rows: rows.length, columns: keys.map((key) => ({ name: key, nonEmpty: rows.filter((row) => row?.[key] !== null && row?.[key] !== undefined && row?.[key] !== '').length })) };
}

export function createLiveToolRegistry({ db, codeRunner, tavily = process.env.TAVILY_API_KEY ? createTavilySearchTool() : null, llm, engineAvailable = false, getWorkspaceRoot = () => process.env.WORKSPACE_ROOT || (() => { throw new Error('WORKSPACE_ROOT_REQUIRED'); })() } = {}) {
  const tools = new Map();
  // Engine-backed handlers compose the EXISTING AgentExecutionEngine. When a
  // per-task engine is present in the tool context, file edits / scans /
  // commands / transactional applies run through it (permissions + evidence +
  // atomic writes). Engine-only tools fail closed when no engine is supplied.
  const engineTools = createEngineToolHandlers();
  const engineGated = new Set(['files.patch', 'terminal.run', 'workspace.apply']);
  const withEngine = (toolId, fallback) => async (args, context = {}) => {
    if (context.engine) return engineTools[toolId](args, context);
    if (fallback) return fallback(args, context);
    return engineTools[toolId](args, context); // throws ENGINE_REQUIRED (fail closed)
  };
  if (tavily) tools.set('web.search', async (args) => await tavily(args));
  tools.set('web.scrape', async (args) => ({ output: await fetchText(args) }));
  const browserPool = new BrowserPool({ maxConcurrent: Number(process.env.BROWSER_POOL_CONCURRENCY || 2), timeoutMs: Number(process.env.BROWSER_TIMEOUT_MS || 30000) });
  tools.set('browser.run', async (args) => {
    const cdp = process.env.BROWSER_CDP_URL;
    if (!cdp) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:browser.run');
    const url = args.url ? (await assertSafeUrlResolved(args.url)).toString() : undefined;
    const actions = Array.isArray(args.actions) ? args.actions.slice(0, 20) : [];
    const checks = Array.isArray(args.checks) ? args.checks.slice(0, 20) : [];
    const result = await runBrowserTask({ webSocketUrl: cdp, url, actions, checks, pool: browserPool });
    return { output: { ok: result.ok, verification: result.verification, screenshot: result.screenshot, results: result.results }, ok: result.ok !== false };
  });
  if (db) tools.set('code.run', async (args, context) => { const result = await createCodeRunHandler(db, { runner: codeRunner })({ run: context.run, payload: args }); return { output: result, ok: result.status === 'completed' }; });
  tools.set('files.read', withEngine('files.read', async (args, context) => { const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path); const content = await readFile(resolved, 'utf8'); return { output: { path: safe, content: content.slice(0, Number(args.maxChars ?? 200000)) } }; }));
  tools.set('files.write', withEngine('files.write', async (args, context) => { const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path); await mkdir(path.dirname(resolved), { recursive: true }); await writeFile(resolved, bounded(args.content, 200000, 'CONTENT'), 'utf8'); return { output: { path: safe, bytes: Buffer.byteLength(args.content) } }; }));
  tools.set('files.patch', withEngine('files.patch'));
  tools.set('files.scan', withEngine('files.scan', async (args, context) => ({ output: { files: await listFiles(context.workspaceRoot, args.scope, Number(args.maxFiles ?? 500)) } })));
  tools.set('terminal.run', withEngine('terminal.run'));
  tools.set('workspace.apply', withEngine('workspace.apply'));
  tools.set('data.profile', async (args, context) => { const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path); const content = await readFile(resolved, 'utf8'); return { output: { path: safe, profile: profile(content.slice(0, 2_000_000), safe) } }; });
  tools.set('data.chart', async (args) => {
    const allowed = new Set(['bar', 'line', 'donut', 'scatter']);
    if (!allowed.has(args.type)) throw new Error('CHART_TYPE_NOT_SUPPORTED');
    if (!args.data || typeof args.data !== 'object' || Array.isArray(args.data)) throw new Error('CHART_DATA_INVALID');
    const series = Object.entries(args.data).map(([name, values]) => {
      if (!Array.isArray(values) || values.length > 10000 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('CHART_SERIES_INVALID');
      return { name: String(name).slice(0, 120), values };
    });
    if (!series.length) throw new Error('CHART_DATA_EMPTY');
    return { output: { type: args.type, title: typeof args.title === 'string' ? args.title.slice(0, 200) : undefined, series, points: Math.max(...series.map((item) => item.values.length)) } };
  });
  tools.set('pdf.extract', async (args, context) => { const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path); return { output: { path: safe, text: await runPdfText(resolved, Number(args.maxChars ?? 200000)) } }; });
  tools.set('code.analyze', async (args, context) => { const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path); const content = await readFile(resolved, 'utf8'); const issues = []; for (const [pattern, rule] of [[/TODO|FIXME|XXX/g, 'todo-comment'], [/\beval\s*\(/g, 'eval-usage'], [/console\.(log|debug)\s*\(/g, 'no-console'], [/api[_-]?key\s*[:=]\s*['"]/ig, 'hardcoded-secret']]) { const matches = content.match(pattern); if (matches?.length) issues.push({ rule, count: matches.length }); } return { output: { path: safe, issues, healthy: issues.length === 0 } }; });
  tools.set('doc.summarize', async (args, context) => { if (!llm) throw new Error('SERVER_LLM_REQUIRED'); const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path); const content = (await readFile(resolved, 'utf8')).slice(0, 120000); const response = await llm.complete({ model: context.model, messages: [{ role: 'system', content: 'Summarize faithfully. Do not invent facts.' }, { role: 'user', content: `Summarize this document in ${args.length || 'medium'} length:\n${content}` }], signal: context.signal }); return { output: { path: safe, summary: response.text, usage: response.usage } }; });
  tools.set('translate', async (args, context) => { if (!llm) throw new Error('SERVER_LLM_REQUIRED'); const response = await llm.complete({ model: context.model, messages: [{ role: 'system', content: 'Translate accurately and return only the translation.' }, { role: 'user', content: `Target language: ${args.target}\nText:\n${args.text}` }], signal: context.signal }); return { output: { translation: response.text, usage: response.usage } }; });
  for (const unavailable of ['image.generate', 'image.analyze', 'calendar.schedule', 'email.send']) tools.set(unavailable, async () => { throw new Error(`TOOL_CONNECTOR_NOT_CONFIGURED:${unavailable}`); });
  return {
    has(toolId) { return tools.has(toolId); },
    async run(toolId, args = {}, context = {}) {
      const definition = TOOL_BY_ID.get(toolId);
      if (!definition) throw new Error(`UNKNOWN_TOOL:${toolId}`);
      const tool = tools.get(toolId);
      if (!tool) throw new Error(`TOOL_NOT_CONNECTED:${toolId}`);
      return tool(args, context);
    },
    status() {
      // Every catalog tool is reported with an explicit, honest state so an
      // operator can never mistake an unavailable capability for a ready one:
      //   live     — fully wired and usable now
      //   partial  — wired but depends on an optional server capability
      //   unwired  — fail-closed until a server-side connector is configured
      //   failed   — registered but its runtime dependency is missing
      const states = new Map();
      const mark = (toolId, state, reason = null) => states.set(toolId, { id: toolId, state, reason });
      const connectorGated = new Set(['image.generate', 'image.analyze', 'calendar.schedule', 'email.send']);
      for (const toolId of tools.keys()) {
        if (connectorGated.has(toolId)) mark(toolId, 'unwired', 'connector_not_configured');
        else if (toolId === 'browser.run' && !process.env.BROWSER_CDP_URL) mark(toolId, 'unwired', 'browser_cdp_not_configured');
        else if (engineGated.has(toolId) && !engineAvailable) mark(toolId, 'partial', 'engine_required');
        else if ((toolId === 'doc.summarize' || toolId === 'translate') && !llm) mark(toolId, 'partial', 'server_llm_optional');
        else mark(toolId, 'live');
      }
      // Catalog tools that were never registered (e.g. web.search without a key).
      for (const tool of TOOL_CATALOG) {
        if (states.has(tool.id)) continue;
        mark(tool.id, 'unwired', tool.id === 'web.search' ? 'search_provider_not_configured' : 'connector_not_configured');
      }
      const details = [...states.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const byState = (state) => details.filter((detail) => detail.state === state).map((detail) => detail.id);
      return { live: byState('live'), partial: byState('partial'), unwired: byState('unwired'), failed: byState('failed'), catalogOnly: [], simulated: [], dangerous: [...DANGEROUS_TOOLS], tools: details };
    },
  };
}
