import { readFile, writeFile, readdir, stat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createTavilySearchTool } from '../../execution-core/tavily-search.mjs';
import { createEngineToolHandlers } from '../../execution-core/engine-tools.mjs';
import { createCodeRunHandler } from '../runners/code-runner.mjs';
import { BrowserPool } from '../browser/pool.mjs';
import { runBrowserTask } from '../browser/runner.mjs';
import { resolveCdpEndpoint, browserBinaryAvailable } from '../browser/launcher.mjs';
import { assertSafeUrlResolved, assertWorkspacePath, safeFetchText } from '../security/validators.mjs';
import { DANGEROUS_TOOLS, TOOL_BY_ID, TOOL_CATALOG } from '../agent/catalog.mjs';
import { createImageProvider, createVisionProvider, createCalendarProvider, createEmailSendProvider, createSlackProvider, createTeamsProvider, createDiscordProvider, createNotionProvider, createWebhookProvider, connectorStatus } from './connectors.mjs';
import { createGitHubClient, githubStatus, parseRepoSlug } from '../github/service.mjs';
import { resolveGitHubToken } from '../github/connections.mjs';
import { MemoryStore } from '../memory/store.mjs';
import { buildProjectIntelligence } from '../../phase2-core/platform.mjs';
import { analyzeImpact, describeImpact } from '../../phase2-core/impact.mjs';
import { buildChangeSet, describeChangeSet } from '../../phase2-core/changeset.mjs';
import { CodebaseReasoner } from '../../phase2-core/reasoning.mjs';

function bounded(value, max, name) {
  const text = String(value ?? '');
  if (!text || text.length > max) throw new Error(`${name}_OUT_OF_RANGE`);
  return text;
}

// Map a workspace file path to the image MIME type the vision provider needs.
// Unknown extensions default to image/png so the provider still receives a
// valid, non-empty type instead of a broken header.
function mimeTypeFor(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.png':
    default:
      return 'image/png';
  }
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
  // SSRF-hardened fetch: the address validated by the guard is PINNED onto the
  // socket (via `lookup`), so a rebinding host cannot pass the check and then
  // resolve to a private IP (DNS rebinding / TOCTOU). Redirects are re-validated
  // hop by hop by `safeFetchText`.
  const { url, status, headers, body } = await safeFetchText(args.url, { timeoutMs: 15_000 });
  if (status < 200 || status >= 300) throw new Error(`WEB_SCRAPE_HTTP_${status}`);
  const contentType = String(headers['content-type'] ?? '');
  if (!contentType.includes('text/') && !contentType.includes('json') && !contentType.includes('xml')) throw new Error('WEB_SCRAPE_UNSUPPORTED_CONTENT');
  return { url, content: body.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, Math.min(Number(args.maxChars ?? 30000), 50000)) };
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

// Decode the handful of HTML entities that matter for text extraction, then
// collapse whitespace. Bounded input is assumed by callers.
function stripTags(value) {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Structured extraction from an HTML document: metadata, headings, bounded
// links and JSON-LD. Everything is derived from the real fetched bytes.
export function extractStructured(url, html, { maxLinks = 50, maxChars = 30000 } = {}) {
  const source = String(html);
  const pick = (regex) => { const match = source.match(regex); return match ? stripTags(match[1]) : null; };
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  const canonical = pick(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
  const headings = [...source.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .slice(0, 40)
    .map((match) => ({ level: Number(match[1]), text: stripTags(match[2]).slice(0, 200) }))
    .filter((heading) => heading.text);
  const linkLimit = Math.min(Math.max(Number(maxLinks) || 50, 1), 200);
  const links = [];
  for (const match of source.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    if (links.length >= linkLimit) break;
    const href = match[1].trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    links.push({ href, text: stripTags(match[2]).slice(0, 120) });
  }
  const jsonLd = [];
  for (const match of source.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { jsonLd.push(JSON.parse(match[1].trim())); } catch { /* ignore malformed JSON-LD */ }
    if (jsonLd.length >= 10) break;
  }
  const text = stripTags(source.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')).slice(0, Math.min(Number(maxChars) || 30000, 50000));
  return { url, title, description, canonical, headings, links, jsonLd, text };
}

// Run an external extractor with a bounded output buffer. Resolves with the
// (possibly truncated) stdout; rejects only when nothing usable was produced.
function runCommand(command, args, { maxChars = 200000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (out.length > maxChars) child.kill('SIGTERM'); });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => ((code === 0 || out) ? resolve(out.slice(0, maxChars)) : reject(new Error(err || `${command}_FAILED`))));
  });
}

// Strip XML tags while preserving paragraph breaks (docx / odt bodies).
function stripXml(xml) {
  return String(xml)
    .replace(/<\/(?:w:p|text:p)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extract text from a workspace document using the real installed extractors.
async function extractDocument(file, maxChars) {
  const ext = path.extname(file).toLowerCase();
  if (['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.html', '.htm'].includes(ext)) {
    return { method: 'read', text: (await readFile(file, 'utf8')).slice(0, maxChars) };
  }
  if (ext === '.docx') {
    const xml = await runCommand('unzip', ['-p', file, 'word/document.xml'], { maxChars: 5_000_000 });
    return { method: 'unzip', text: stripXml(xml).slice(0, maxChars) };
  }
  if (ext === '.odt') {
    const xml = await runCommand('unzip', ['-p', file, 'content.xml'], { maxChars: 5_000_000 });
    return { method: 'unzip', text: stripXml(xml).slice(0, maxChars) };
  }
  if (ext === '.rtf') return { method: 'unrtf', text: (await runCommand('unrtf', ['--text', file], { maxChars })).slice(0, maxChars) };
  if (ext === '.doc') {
    try { return { method: 'antiword', text: (await runCommand('antiword', [file], { maxChars })).slice(0, maxChars) }; }
    catch { return { method: 'catdoc', text: (await runCommand('catdoc', [file], { maxChars })).slice(0, maxChars) }; }
  }
  return { method: 'read', text: (await readFile(file, 'utf8')).slice(0, maxChars) };
}

export function createLiveToolRegistry({ db, codeRunner, tavily = process.env.TAVILY_API_KEY ? createTavilySearchTool() : null, llm, engineAvailable = false, getWorkspaceRoot = () => process.env.WORKSPACE_ROOT || (() => { throw new Error('WORKSPACE_ROOT_REQUIRED'); })(), memory } = {}) {
  const tools = new Map();
  // Long-term project memory: reuse the EXISTING MemoryStore (hybrid lexical +
  // semantic). Created from `db` when a store is not injected, so the agent can
  // read/write durable project context without any new storage layer.
  const memoryStore = memory ?? (db ? new MemoryStore(db) : null);
  // Git lifecycle tools run through the per-task engine's RealGit (permissions +
  // evidence + protected-branch refusal). They fail closed with ENGINE_REQUIRED
  // when no engine is supplied.
  const withGit = (fn) => async (args = {}, context = {}) => {
    const git = context?.engine?.git;
    if (!git) throw new Error('ENGINE_REQUIRED');
    return fn(git, args, context);
  };
  // GitHub tools resolve the tenant token from the stored (encrypted) connection,
  // then fall back to an operator GITHUB_TOKEN. They fail closed when nothing is
  // configured so an unavailable integration is never mistaken for a ready one.
  const githubClientFor = (context = {}) => {
    let token = null;
    if (db) { try { token = resolveGitHubToken(db, context?.run?.tenant_id); } catch { token = null; } }
    if (!token) token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
    if (!token) throw new Error('GITHUB_NOT_CONFIGURED');
    return createGitHubClient({ token });
  };
  const repoArgs = (args) => parseRepoSlug(args.repo);
  // Connector-backed tools share one shape: resolve the provider from the env and
  // fail closed with TOOL_CONNECTOR_NOT_CONFIGURED:<id> when nothing is set.
  const connectorTool = (toolId, factory, invoke) => async (args = {}) => {
    const provider = factory();
    if (!provider) throw new Error(`TOOL_CONNECTOR_NOT_CONFIGURED:${toolId}`);
    return { output: await invoke(provider, args) };
  };
  // Engine-backed handlers compose the EXISTING AgentExecutionEngine. When a
  // per-task engine is present in the tool context, file edits / scans /
  // commands / transactional applies run through it (permissions + evidence +
  // atomic writes). Engine-only tools fail closed when no engine is supplied.
  const engineTools = createEngineToolHandlers();
  const engineGated = new Set(['files.patch', 'terminal.run', 'workspace.apply', 'git.status', 'git.diff', 'git.log', 'git.checkpoint']);
  // Code-intelligence tools degrade (rather than fail closed) when no per-task
  // engine is supplied, so they are reported `partial` instead of `live`.
  const enginePartial = new Set(['code.changeset']);
  const withEngine = (toolId, fallback) => async (args, context = {}) => {
    if (context.engine) return engineTools[toolId](args, context);
    if (fallback) return fallback(args, context);
    return engineTools[toolId](args, context); // throws ENGINE_REQUIRED (fail closed)
  };
  // Shared, TTL-bounded project index so a burst of code-intelligence tool calls
  // (impact + reason + changeset in one plan) indexes the workspace once instead
  // of three times. `refresh:true` forces a rebuild and a failed build is dropped
  // from the cache so the next call retries instead of caching the rejection.
  const indexCache = new Map();
  const indexTtlMs = Math.max(0, Number(process.env.CODE_INDEX_TTL_MS ?? 10000) || 0);
  const projectIndex = (root, { refresh = false } = {}) => {
    const key = path.resolve(root);
    const cached = indexCache.get(key);
    if (!refresh && cached && Date.now() - cached.at < indexTtlMs) return cached.promise;
    const promise = buildProjectIntelligence(key);
    indexCache.set(key, { at: Date.now(), promise });
    promise.catch(() => { if (indexCache.get(key)?.promise === promise) indexCache.delete(key); });
    return promise;
  };
  if (tavily) tools.set('web.search', async (args) => await tavily(args));
  tools.set('web.scrape', async (args) => ({ output: await fetchText(args) }));
  const browserPool = new BrowserPool({ maxConcurrent: Number(process.env.BROWSER_POOL_CONCURRENCY || 2), timeoutMs: Number(process.env.BROWSER_TIMEOUT_MS || 30000) });
  tools.set('browser.run', async (args) => {
    // Prefer an operator-managed CDP endpoint; otherwise launch a local browser
    // when explicitly enabled. resolveCdpEndpoint fails closed when neither is
    // available so this tool never reports a fake success.
    const { webSocketUrl, launcher } = await resolveCdpEndpoint();
    try {
      const url = args.url ? (await assertSafeUrlResolved(args.url)).toString() : undefined;
      const actions = Array.isArray(args.actions) ? args.actions.slice(0, 20) : [];
      const checks = Array.isArray(args.checks) ? args.checks.slice(0, 20) : [];
      const result = await runBrowserTask({ webSocketUrl, url, actions, checks, pool: browserPool });
      return { output: { ok: result.ok, verification: result.verification, screenshot: result.screenshot, results: result.results }, ok: result.ok !== false };
    } finally {
      if (launcher) { try { await launcher.close(); } catch { /* cleanup must not mask result */ } }
    }
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
  // Impact Analysis: blast radius of a set of changed files over the project index.
  tools.set('code.impact', async (args, context) => {
    if (!context.workspaceRoot) throw new Error('WORKSPACE_ROOT_REQUIRED');
    const intelligence = await projectIndex(context.workspaceRoot, { refresh: args.refresh === true });
    const impact = analyzeImpact(intelligence, { changedFiles: args.changedFiles, maxDepth: args.maxDepth });
    return { output: { ...impact, description: describeImpact(impact) } };
  });
  // Change Intelligence: structured ChangeSet from the workspace Git status/diff,
  // enriched with the impact analysis and a verification plan. Uses the real
  // engine Git when present; degrades to an empty (honest) status otherwise.
  tools.set('code.changeset', async (args, context) => {
    if (!context.workspaceRoot) throw new Error('WORKSPACE_ROOT_REQUIRED');
    const intelligence = await projectIndex(context.workspaceRoot, { refresh: args.refresh === true });
    let status = [];
    let diff = '';
    if (context.engine?.git) {
      try { status = (await context.engine.git.status()).entries ?? []; } catch { status = []; }
      try { diff = (await context.engine.git.diff()).stdout ?? ''; } catch { diff = ''; }
    }
    const changeSet = buildChangeSet({ status, diff, intelligence, goal: args.goal });
    return { output: { ...changeSet, description: describeChangeSet(changeSet) } };
  });
  // Deep Codebase Reasoning: definition / references / trace / explain / search
  // over the project index. Lexical reference scanning reads real files (real
  // line numbers); without a reader it stays structural (no invented lines).
  tools.set('code.reason', async (args, context) => {
    if (!context.workspaceRoot) throw new Error('WORKSPACE_ROOT_REQUIRED');
    const root = context.workspaceRoot;
    const intelligence = await projectIndex(root, { refresh: args.refresh === true });
    const reasoner = new CodebaseReasoner(intelligence, {
      read: async (relative) => { const { resolved } = await workspacePath(root, relative); return readFile(resolved, 'utf8'); },
    });
    const mode = String(args.mode || 'auto');
    const target = args.target || args.question;
    if (mode === 'definition') return { output: reasoner.definition(target) };
    if (mode === 'references') return { output: await reasoner.references(target) };
    if (mode === 'trace') return { output: reasoner.trace(args.from, args.to) };
    if (mode === 'explain') return { output: await reasoner.explain(target) };
    if (mode === 'search') return { output: { results: reasoner.search(args.question) } };
    return { output: await reasoner.answer(args.question) };
  });
  tools.set('doc.summarize', async (args, context) => { if (!llm) throw new Error('SERVER_LLM_REQUIRED'); const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path); const content = (await readFile(resolved, 'utf8')).slice(0, 120000); const response = await llm.complete({ model: context.model, messages: [{ role: 'system', content: 'Summarize faithfully. Do not invent facts.' }, { role: 'user', content: `Summarize this document in ${args.length || 'medium'} length:\n${content}` }], signal: context.signal }); return { output: { path: safe, summary: response.text, usage: response.usage } }; });
  tools.set('translate', async (args, context) => { if (!llm) throw new Error('SERVER_LLM_REQUIRED'); const response = await llm.complete({ model: context.model, messages: [{ role: 'system', content: 'Translate accurately and return only the translation.' }, { role: 'user', content: `Target language: ${args.target}\nText:\n${args.text}` }], signal: context.signal }); return { output: { translation: response.text, usage: response.usage } }; });
  // Connector-backed tools. Each handler resolves its provider from the
  // environment and fails closed with TOOL_CONNECTOR_NOT_CONFIGURED:<id> when
  // nothing is configured, so an operator can never mistake an unavailable
  // capability for a ready one. When a provider IS configured the call is real.
  tools.set('image.generate', async (args, context = {}) => {
    const provider = createImageProvider();
    if (!provider) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:image.generate');
    const result = await provider.generate({ prompt: bounded(args.prompt, 10000, 'PROMPT'), size: args.size });
    const bytes = Buffer.from(result.base64, 'base64');
    if (context.workspaceRoot) {
      const target = args.path || `generated/image-${Date.now()}.png`;
      const { resolved, safe } = await workspacePath(context.workspaceRoot, target);
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, bytes);
      return { output: { path: safe, bytes: bytes.length, provider: result.provider, model: result.model, revisedPrompt: result.revisedPrompt } };
    }
    return { output: { base64: result.base64, mimeType: result.mimeType, bytes: bytes.length, provider: result.provider, model: result.model, revisedPrompt: result.revisedPrompt } };
  });
  tools.set('image.analyze', async (args, context = {}) => {
    const provider = createVisionProvider();
    if (!provider) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:image.analyze');
    const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path);
    const bytes = await readFile(resolved);
    if (bytes.length > 12 * 1024 * 1024) throw new Error('IMAGE_TOO_LARGE');
    const result = await provider.analyze({ base64: bytes.toString('base64'), mimeType: mimeTypeFor(safe), prompt: args.prompt });
    return { output: { path: safe, analysis: result.text, provider: result.provider, model: result.model, usage: result.usage } };
  });
  tools.set('calendar.schedule', async (args) => {
    const provider = createCalendarProvider();
    if (!provider) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:calendar.schedule');
    const result = await provider.createEvent({ title: bounded(args.title, 500, 'TITLE'), when: args.when, durationMinutes: args.durationMinutes, description: typeof args.description === 'string' ? args.description.slice(0, 5000) : '' });
    return { output: result };
  });
  tools.set('email.send', async (args) => {
    const provider = createEmailSendProvider();
    if (!provider) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:email.send');
    const result = await provider.send({ to: args.to, subject: bounded(args.subject, 500, 'SUBJECT'), body: bounded(args.body, 100000, 'BODY') });
    return { output: { delivered: true, provider: result.provider, messageId: result.messageId } };
  });
  // --- Git lifecycle (reuse engine.git; never reaches push/merge/master) -----
  tools.set('git.status', withGit(async (git) => {
    const result = await git.status();
    const entries = result.entries ?? [];
    const branchEntry = entries.find((entry) => String(entry).startsWith('##')) ?? '';
    const branch = branchEntry.replace(/^##\s*/, '').split(/[.\s]/)[0] || null;
    return { output: { branch, entries: entries.filter((entry) => !String(entry).startsWith('##')), raw: String(result.stdout ?? '').slice(0, 20000) } };
  }));
  tools.set('git.diff', withGit(async (git, args) => {
    const result = await git.diff();
    const maxChars = Math.min(Math.max(Number(args.maxChars ?? 100000), 100), 200000);
    const stdout = String(result.stdout ?? '');
    return { output: { diff: stdout.slice(0, maxChars), truncated: stdout.length > maxChars, exitCode: result.exitCode ?? null } };
  }));
  tools.set('git.log', withGit(async (git, args) => {
    if (typeof git.log !== 'function') throw new Error('GIT_LOG_UNAVAILABLE');
    const result = await git.log({ limit: Number(args.limit ?? 20), ref: args.ref });
    return { output: { entries: result.entries ?? [] } };
  }));
  tools.set('git.checkpoint', withGit(async (git, args) => {
    const message = bounded(args.message, 240, 'CHECKPOINT_MESSAGE');
    if (message.trim().length < 3) throw new Error('CHECKPOINT_MESSAGE_TOO_SHORT');
    const result = await git.checkpoint(message);
    return { output: { created: result.created, revision: result.revision ?? null, reason: result.reason ?? null } };
  }));
  // --- GitHub automation (task -> PR -> CI -> fix) ---------------------------
  tools.set('github.repo', async (args, context) => {
    const client = githubClientFor(context);
    return { output: await client.getRepo(repoArgs(args)) };
  });
  tools.set('github.issues.list', async (args, context) => {
    const client = githubClientFor(context);
    const issues = await client.listIssues({ ...repoArgs(args), state: args.state || 'open', limit: Number(args.limit ?? 20) });
    return { output: { issues } };
  });
  tools.set('github.issue.create', async (args, context) => {
    const client = githubClientFor(context);
    const labels = Array.isArray(args.labels) ? args.labels.slice(0, 20).map((label) => String(label).slice(0, 64)) : [];
    const issue = await client.createIssue({ ...repoArgs(args), title: bounded(args.title, 256, 'TITLE'), body: typeof args.body === 'string' ? args.body.slice(0, 100000) : '', labels });
    return { output: issue };
  });
  tools.set('github.issue.comment', async (args, context) => {
    const client = githubClientFor(context);
    const comment = await client.commentOnIssue({ ...repoArgs(args), issueNumber: Number(args.number), body: bounded(args.body, 100000, 'BODY') });
    return { output: comment };
  });
  tools.set('github.pr.create', async (args, context) => {
    const client = githubClientFor(context);
    let head = args.head ? String(args.head) : null;
    if (!head && context?.engine?.git) { try { head = (await context.engine.git.branch()).branch; } catch { head = null; } }
    if (!head) throw new Error('GITHUB_PR_HEAD_REQUIRED');
    const pr = await client.createPullRequest({ ...repoArgs(args), title: bounded(args.title, 256, 'TITLE'), head, base: bounded(args.base, 256, 'BASE'), body: typeof args.body === 'string' ? args.body.slice(0, 100000) : '', draft: args.draft === true });
    return { output: { ...pr, head } };
  });
  tools.set('github.ci.status', async (args, context) => {
    const client = githubClientFor(context);
    const { owner, repo } = repoArgs(args);
    let ref = args.ref ? String(args.ref) : null;
    if (!ref && context?.engine?.git) { try { ref = (await context.engine.git.branch()).branch; } catch { ref = null; } }
    if (!ref) ref = 'HEAD';
    const [combined, checks, runs] = await Promise.all([
      client.getCombinedStatus({ owner, repo, ref }).catch(() => null),
      client.listCheckRuns({ owner, repo, ref }).catch(() => null),
      client.listWorkflowRuns({ owner, repo, branch: args.branch || ref, limit: 10 }).catch(() => null),
    ]);
    const checkRuns = checks?.checkRuns ?? [];
    const failing = checkRuns.filter((run) => run.conclusion && !['success', 'neutral', 'skipped'].includes(run.conclusion));
    const workflowRuns = runs?.runs ?? [];
    const failedRuns = workflowRuns.filter((run) => run.conclusion === 'failure');
    const green = combined?.state === 'success' && failing.length === 0 && failedRuns.length === 0;
    return { output: { ref, state: combined?.state ?? 'unknown', combined, checkRuns, workflowRuns, failing: failing.map((run) => run.name), failedRuns: failedRuns.map((run) => run.name), green } };
  });
  // --- Research / content ----------------------------------------------------
  tools.set('web.extract', async (args) => {
    const { url, status, headers, body } = await safeFetchText(args.url, { timeoutMs: 15000 });
    if (status < 200 || status >= 300) throw new Error(`WEB_EXTRACT_HTTP_${status}`);
    const contentType = String(headers['content-type'] ?? '');
    if (!contentType.includes('text/') && !contentType.includes('json') && !contentType.includes('xml')) throw new Error('WEB_EXTRACT_UNSUPPORTED_CONTENT');
    return { output: extractStructured(url, body, { maxLinks: Number(args.maxLinks ?? 50), maxChars: Number(args.maxChars ?? 30000) }) };
  });
  tools.set('doc.extract', async (args, context) => {
    const { resolved, safe } = await workspacePath(context.workspaceRoot, args.path);
    const maxChars = Math.min(Math.max(Number(args.maxChars ?? 200000), 100), 200000);
    const result = await extractDocument(resolved, maxChars);
    return { output: { path: safe, method: result.method, text: result.text } };
  });
  // --- Long-term memory ------------------------------------------------------
  tools.set('memory.search', async (args, context) => {
    if (!memoryStore) throw new Error('MEMORY_UNAVAILABLE');
    const tenantId = context?.run?.tenant_id;
    const projectId = context?.task?.project_id;
    if (!tenantId || !projectId) throw new Error('MEMORY_CONTEXT_REQUIRED');
    const results = await memoryStore.search({ tenantId, projectId, query: bounded(args.query, 500, 'QUERY'), limit: Number(args.limit ?? 5) });
    return { output: { results } };
  });
  tools.set('memory.write', async (args, context) => {
    if (!memoryStore) throw new Error('MEMORY_UNAVAILABLE');
    const tenantId = context?.run?.tenant_id;
    const projectId = context?.task?.project_id;
    if (!tenantId || !projectId) throw new Error('MEMORY_CONTEXT_REQUIRED');
    const document = await memoryStore.addDocument({ tenantId, projectId, source: typeof args.source === 'string' ? args.source.slice(0, 200) : 'agent', content: bounded(args.content, 200000, 'CONTENT') });
    return { output: { id: document.id, source: document.source, createdAt: document.created_at } };
  });
  // --- Code review (LLM reasoning over the real diff) ------------------------
  tools.set('code.review', async (args, context) => {
    if (!llm) throw new Error('SERVER_LLM_REQUIRED');
    let diff = typeof args.diff === 'string' ? args.diff : '';
    if (!diff && context?.engine?.git) { try { diff = String((await context.engine.git.diff()).stdout ?? ''); } catch { diff = ''; } }
    if (!diff && args.path && context?.workspaceRoot) { const { resolved } = await workspacePath(context.workspaceRoot, args.path); diff = (await readFile(resolved, 'utf8')).slice(0, 120000); }
    if (!diff) throw new Error('CODE_REVIEW_NO_INPUT');
    const response = await llm.complete({ model: context.model, messages: [
      { role: 'system', content: 'You are a rigorous senior code reviewer. Return ONLY JSON: {"summary":string,"findings":[{"severity":"high|medium|low","file":string,"issue":string,"suggestion":string}],"verdict":"approve|request_changes"}. Base every finding on the provided diff only; never invent files or lines.' },
      { role: 'user', content: `Focus: ${args.focus || 'general correctness, security and maintainability'}\n\nDiff:\n${diff.slice(0, 120000)}` },
    ], signal: context.signal });
    let parsed = null;
    try { parsed = JSON.parse(String(response.text).match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch { parsed = null; }
    return { output: { review: parsed ?? response.text, usage: response.usage } };
  });
  // --- Notification / knowledge connectors -----------------------------------
  tools.set('slack.post', connectorTool('slack.post', createSlackProvider, (provider, args) => provider.post({ text: bounded(args.text, 40000, 'TEXT'), channel: args.channel })));
  tools.set('teams.post', connectorTool('teams.post', createTeamsProvider, (provider, args) => provider.post({ text: bounded(args.text, 40000, 'TEXT'), title: args.title })));
  tools.set('discord.post', connectorTool('discord.post', createDiscordProvider, (provider, args) => provider.post({ text: bounded(args.text, 2000, 'TEXT'), username: args.username })));
  tools.set('notion.page.create', connectorTool('notion.page.create', createNotionProvider, (provider, args) => provider.createPage({ title: bounded(args.title, 200, 'TITLE'), content: typeof args.content === 'string' ? args.content.slice(0, 100000) : '', databaseId: args.databaseId, pageId: args.pageId })));
  tools.set('webhook.post', connectorTool('webhook.post', createWebhookProvider, (provider, args) => provider.post({ text: bounded(args.text, 40000, 'TEXT'), event: args.event, data: args.data })));
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
      // Resolve which connectors are actually configured right now. A tool is
      // only reported live when its provider exists; otherwise it stays
      // unwired so the operator sees the truth instead of a fake success.
      const connectors = connectorStatus();
      const connectorGated = new Map([
        ['image.generate', { ok: connectors.image, reason: 'image_provider_not_configured' }],
        ['image.analyze', { ok: connectors.vision, reason: 'vision_provider_not_configured' }],
        ['calendar.schedule', { ok: connectors.calendar, reason: 'calendar_provider_not_configured' }],
        ['email.send', { ok: connectors.email, reason: 'email_provider_not_configured' }],
        ['slack.post', { ok: connectors.slack, reason: 'slack_provider_not_configured' }],
        ['teams.post', { ok: connectors.teams, reason: 'teams_provider_not_configured' }],
        ['discord.post', { ok: connectors.discord, reason: 'discord_provider_not_configured' }],
        ['notion.page.create', { ok: connectors.notion, reason: 'notion_provider_not_configured' }],
        ['webhook.post', { ok: connectors.webhook, reason: 'webhook_provider_not_configured' }],
      ]);
      // GitHub tools are ready when an operator token exists or any tenant has a
      // stored (encrypted) connection; otherwise they report unwired.
      let githubReady = githubStatus().configured;
      if (!githubReady && db) { try { githubReady = Boolean(db.get('SELECT 1 AS ok FROM github_connections LIMIT 1')); } catch { githubReady = false; } }
      for (const toolId of tools.keys()) {
        const gate = connectorGated.get(toolId);
        if (gate && !gate.ok) mark(toolId, 'unwired', gate.reason);
        else if (toolId === 'browser.run' && !process.env.BROWSER_CDP_URL) {
          if (process.env.BROWSER_LAUNCH_LOCAL === 'true' && browserBinaryAvailable()) mark(toolId, 'live');
          else if (process.env.BROWSER_LAUNCH_LOCAL === 'true') mark(toolId, 'unwired', 'browser_binary_not_found');
          else mark(toolId, 'unwired', 'browser_cdp_not_configured');
        }
        else if (toolId.startsWith('github.') && !githubReady) mark(toolId, 'unwired', 'github_not_configured');
        else if (engineGated.has(toolId) && !engineAvailable) mark(toolId, 'partial', 'engine_required');
        else if ((toolId === 'doc.summarize' || toolId === 'translate' || toolId === 'code.review') && !llm) mark(toolId, 'partial', 'server_llm_optional');
        else if (toolId.startsWith('memory.') && !memoryStore) mark(toolId, 'partial', 'memory_unavailable');
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
