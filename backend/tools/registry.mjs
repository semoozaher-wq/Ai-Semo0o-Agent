import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createTavilySearchTool } from '../../execution-core/tavily-search.mjs';
import { createCodeRunHandler } from '../runners/code-runner.mjs';
import { assertSafeUrl, assertWorkspacePath } from '../security/validators.mjs';
import { DANGEROUS_TOOLS, TOOL_BY_ID } from '../agent/catalog.mjs';

function bounded(value, max, name) {
  const text = String(value ?? '');
  if (!text || text.length > max) throw new Error(`${name}_OUT_OF_RANGE`);
  return text;
}
function workspacePath(root, relative) {
  const safe = assertWorkspacePath(relative);
  const resolved = path.resolve(root, safe);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error('PATH_OUTSIDE_WORKSPACE');
  return { safe, resolved };
}
async function fetchText(args) {
  const url = assertSafeUrl(args.url);
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
  const start = workspacePath(root, scope || '.').resolved;
  const output = [];
  async function visit(dir, relative) {
    if (output.length >= maxFiles) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.expo') continue;
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

export function createLiveToolRegistry({ db, codeRunner, tavily = process.env.TAVILY_API_KEY ? createTavilySearchTool() : null, llm, getWorkspaceRoot = () => process.env.WORKSPACE_ROOT || process.cwd() } = {}) {
  const tools = new Map();
  if (tavily) tools.set('web.search', async (args) => await tavily(args));
  tools.set('web.scrape', async (args) => ({ output: await fetchText(args) }));
  if (db) tools.set('code.run', async (args, context) => { const result = await createCodeRunHandler(db, { runner: codeRunner })({ run: context.run, payload: args }); return { output: result, ok: result.status === 'completed' }; });
  tools.set('files.read', async (args, context) => { const { resolved, safe } = workspacePath(context.workspaceRoot, args.path); const content = await readFile(resolved, 'utf8'); return { output: { path: safe, content: content.slice(0, Number(args.maxChars ?? 200000)) } }; });
  tools.set('files.write', async (args, context) => { const { resolved, safe } = workspacePath(context.workspaceRoot, args.path); await mkdir(path.dirname(resolved), { recursive: true }); await writeFile(resolved, bounded(args.content, 200000, 'CONTENT'), 'utf8'); return { output: { path: safe, bytes: Buffer.byteLength(args.content) } }; });
  tools.set('files.scan', async (args, context) => ({ output: { files: await listFiles(context.workspaceRoot, args.scope, Number(args.maxFiles ?? 500)) } }));
  tools.set('data.profile', async (args, context) => { const { resolved, safe } = workspacePath(context.workspaceRoot, args.path); const content = await readFile(resolved, 'utf8'); return { output: { path: safe, profile: profile(content.slice(0, 2_000_000), safe) } }; });
  tools.set('pdf.extract', async (args, context) => { const { resolved, safe } = workspacePath(context.workspaceRoot, args.path); return { output: { path: safe, text: await runPdfText(resolved, Number(args.maxChars ?? 200000)) } }; });
  tools.set('code.analyze', async (args, context) => { const { resolved, safe } = workspacePath(context.workspaceRoot, args.path); const content = await readFile(resolved, 'utf8'); const issues = []; for (const [pattern, rule] of [[/TODO|FIXME|XXX/g, 'todo-comment'], [/\beval\s*\(/g, 'eval-usage'], [/console\.(log|debug)\s*\(/g, 'no-console'], [/api[_-]?key\s*[:=]\s*['"]/ig, 'hardcoded-secret']]) { const matches = content.match(pattern); if (matches?.length) issues.push({ rule, count: matches.length }); } return { output: { path: safe, issues, healthy: issues.length === 0 } }; });
  tools.set('doc.summarize', async (args, context) => { if (!llm) throw new Error('SERVER_LLM_REQUIRED'); const { resolved, safe } = workspacePath(context.workspaceRoot, args.path); const content = (await readFile(resolved, 'utf8')).slice(0, 120000); const response = await llm.complete({ model: context.model, messages: [{ role: 'system', content: 'Summarize faithfully. Do not invent facts.' }, { role: 'user', content: `Summarize this document in ${args.length || 'medium'} length:\n${content}` }], signal: context.signal }); return { output: { path: safe, summary: response.text, usage: response.usage } }; });
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
    status() { return { live: [...tools.keys()].filter((id) => !['image.generate', 'image.analyze', 'calendar.schedule', 'email.send'].includes(id)), catalogOnly: [], simulated: [], unwired: ['image.generate', 'image.analyze', 'calendar.schedule', 'email.send'], dangerous: [...DANGEROUS_TOOLS] }; },
  };
}
