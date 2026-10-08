import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { DANGEROUS_TOOLS, TOOL_BY_ID, fromProviderToolName, openAITools } from '../agent/catalog.mjs';
import { createLiveToolRegistry, extractStructured } from '../tools/registry.mjs';
import { Database, now } from '../db/client.mjs';

/**
 * Expanded-capability suite. Every test proves a REAL behaviour of the tools
 * added to move the agent toward a general-purpose autonomous platform:
 *   - git lifecycle tools run through a per-task engine (and fail closed without one);
 *   - GitHub automation reads repo/CI and opens PRs (stubbed HTTP, real code path);
 *   - notification connectors deliver over real TCP and sign the generic webhook;
 *   - long-term memory persists and retrieves through the real SQLite store;
 *   - document extraction reads a real .docx container;
 *   - web extraction parses real HTML bytes and refuses SSRF targets.
 * Nothing is asserted from a flag or a file's existence.
 */

const run = promisify(execFile);
const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-expanded-'));

async function withEnv(vars, fn) {
  const snapshot = new Map();
  for (const key of Object.keys(vars)) {
    snapshot.set(key, process.env[key]);
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try { return await fn(); } finally {
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function startServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { const record = { method: req.method, url: req.url, headers: req.headers, body }; requests.push(record); handler(record, res); });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

const NEW_TOOLS = ['git.status', 'git.diff', 'git.log', 'git.checkpoint', 'github.repo', 'github.issues.list', 'github.issue.create', 'github.issue.comment', 'github.pr.create', 'github.ci.status', 'web.extract', 'doc.extract', 'memory.search', 'memory.write', 'code.review', 'slack.post', 'teams.post', 'discord.post', 'notion.page.create', 'webhook.post'];
const NEW_DANGEROUS = ['git.checkpoint', 'github.issue.create', 'github.issue.comment', 'github.pr.create', 'memory.write', 'slack.post', 'teams.post', 'discord.post', 'notion.page.create', 'webhook.post'];

/* -------------------------------------------------------------------------- */
/*  Catalog + provider-name round-trip                                         */
/* -------------------------------------------------------------------------- */

test('catalog: every new capability is registered with a strict schema and an honest danger flag', () => {
  for (const id of NEW_TOOLS) {
    const tool = TOOL_BY_ID.get(id);
    assert.ok(tool, `${id} must be registered in the catalog`);
    assert.equal(tool.parameters.type, 'object', `${id} must take an object`);
    assert.equal(tool.parameters.additionalProperties, false, `${id} must reject unknown args`);
    assert.ok(tool.description && tool.description.length > 10, `${id} must describe itself`);
  }
  for (const id of NEW_DANGEROUS) assert.ok(DANGEROUS_TOOLS.has(id), `${id} must be flagged dangerous`);
  for (const id of NEW_TOOLS.filter((id) => !NEW_DANGEROUS.includes(id))) assert.ok(!DANGEROUS_TOOLS.has(id), `${id} must NOT be dangerous`);
});

test('catalog: provider tool names round-trip for every new tool', () => {
  const names = new Set(openAITools().map((tool) => tool.function.name));
  for (const id of NEW_TOOLS) {
    const provider = id.replaceAll('.', '__');
    assert.ok(names.has(provider), `${provider} must be exposed to the model`);
    assert.equal(fromProviderToolName(provider), id);
  }
});

/* -------------------------------------------------------------------------- */
/*  Honest status gating                                                       */
/* -------------------------------------------------------------------------- */

test('status: new tools report honest states when nothing is configured', async () => {
  await withEnv({
    GITHUB_TOKEN: undefined, GH_TOKEN: undefined, SLACK_WEBHOOK_URL: undefined, SLACK_BOT_TOKEN: undefined,
    TEAMS_WEBHOOK_URL: undefined, DISCORD_WEBHOOK_URL: undefined, GENERIC_WEBHOOK_URL: undefined,
    NOTION_API_KEY: undefined, NOTION_DATABASE_ID: undefined, NOTION_PAGE_ID: undefined,
  }, async () => {
    const registry = createLiveToolRegistry();
    const status = registry.status();
    const state = (id) => status.tools.find((tool) => tool.id === id);
    for (const id of ['slack.post', 'teams.post', 'discord.post', 'notion.page.create', 'webhook.post']) assert.equal(state(id).state, 'unwired', `${id} must be unwired`);
    for (const id of ['github.repo', 'github.issues.list', 'github.pr.create', 'github.ci.status']) assert.equal(state(id).state, 'unwired', `${id} must be unwired`);
    assert.equal(state('github.repo').reason, 'github_not_configured');
    for (const id of ['git.status', 'git.diff', 'git.log', 'git.checkpoint']) { assert.equal(state(id).state, 'partial', `${id} must be partial`); assert.equal(state(id).reason, 'engine_required'); }
    for (const id of ['memory.search', 'memory.write']) { assert.equal(state(id).state, 'partial'); assert.equal(state(id).reason, 'memory_unavailable'); }
    assert.equal(state('code.review').state, 'partial');
  });
});

test('status: connector-backed tools flip to live once their credential exists', async () => {
  await withEnv({
    SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x', TEAMS_WEBHOOK_URL: 'https://teams.test/x',
    DISCORD_WEBHOOK_URL: 'https://discord.test/x', GENERIC_WEBHOOK_URL: 'https://wh.test/x',
    NOTION_API_KEY: 'notion_key_value', NOTION_DATABASE_ID: 'db_1',
  }, async () => {
    const registry = createLiveToolRegistry();
    const status = registry.status();
    for (const id of ['slack.post', 'teams.post', 'discord.post', 'notion.page.create', 'webhook.post']) assert.equal(status.tools.find((tool) => tool.id === id).state, 'live', `${id} must be live`);
  });
});

/* -------------------------------------------------------------------------- */
/*  Git lifecycle tools (per-task engine)                                      */
/* -------------------------------------------------------------------------- */

test('git tools: read status/diff/log and create a checkpoint through the per-task engine', async () => {
  const seen = [];
  const fakeGit = {
    async status() { return { entries: ['## feature/x', ' M a.txt'] }; },
    async diff() { return { stdout: 'diff --git a/a.txt b/a.txt\n+hello', exitCode: 0 }; },
    async log({ limit, ref }) { seen.push({ limit, ref }); return { entries: [{ sha: 'abc123', author: 'A', date: '2026-01-01T00:00:00Z', subject: 'init' }] }; },
    async checkpoint(message) { seen.push({ message }); return { created: true, revision: 'rev1' }; },
  };
  const registry = createLiveToolRegistry();
  const ctx = { engine: { git: fakeGit } };

  const status = await registry.run('git.status', {}, ctx);
  assert.equal(status.output.branch, 'feature/x');
  assert.deepEqual(status.output.entries, [' M a.txt']);

  const diff = await registry.run('git.diff', {}, ctx);
  assert.match(diff.output.diff, /\+hello/);
  assert.equal(diff.output.exitCode, 0);

  const log = await registry.run('git.log', { limit: 5, ref: 'main' }, ctx);
  assert.equal(log.output.entries[0].sha, 'abc123');
  assert.deepEqual(seen[0], { limit: 5, ref: 'main' });

  const checkpoint = await registry.run('git.checkpoint', { message: 'checkpoint one' }, ctx);
  assert.equal(checkpoint.output.created, true);
  assert.equal(checkpoint.output.revision, 'rev1');
});

test('git tools: fail closed with ENGINE_REQUIRED when no per-task engine is present', async () => {
  const registry = createLiveToolRegistry();
  await assert.rejects(() => registry.run('git.status', {}), /ENGINE_REQUIRED/);
  await assert.rejects(() => registry.run('git.checkpoint', { message: 'a valid message' }), /ENGINE_REQUIRED/);
});

/* -------------------------------------------------------------------------- */
/*  GitHub automation (stubbed HTTP, real code path)                           */
/* -------------------------------------------------------------------------- */

test('github tools: read repo/CI and open a PR from the task branch', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    seen.push({ url: target, method: init.method || 'GET', body: init.body });
    const ok = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    if (target.endsWith('/repos/o/r')) return ok({ full_name: 'o/r', default_branch: 'main', private: false, html_url: 'https://github.com/o/r' });
    if (target.includes('/status')) return ok({ state: 'success', total_count: 1, statuses: [] });
    if (target.includes('/check-runs')) return ok({ total_count: 1, check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
    if (target.includes('/actions/runs')) return ok({ total_count: 1, workflow_runs: [{ id: 9, name: 'ci', status: 'completed', conclusion: 'success' }] });
    if (target.endsWith('/pulls')) return ok({ number: 7, html_url: 'https://github.com/o/r/pull/7', state: 'open' });
    return ok({});
  };
  try {
    await withEnv({ GITHUB_TOKEN: 'ghp_test_token_value' }, async () => {
      const registry = createLiveToolRegistry();
      assert.equal(registry.status().tools.find((tool) => tool.id === 'github.repo').state, 'live');
      const repo = await registry.run('github.repo', { repo: 'o/r' });
      assert.equal(repo.output.fullName, 'o/r');
      const engine = { git: { async branch() { return { branch: 'feature/x' }; } } };
      const ci = await registry.run('github.ci.status', { repo: 'o/r' }, { engine });
      assert.equal(ci.output.green, true);
      assert.equal(ci.output.ref, 'feature/x');
      const pr = await registry.run('github.pr.create', { repo: 'o/r', title: 'Ship it', base: 'main' }, { engine });
      assert.equal(pr.output.number, 7);
      assert.equal(pr.output.head, 'feature/x');
      const prCall = seen.find((call) => call.method === 'POST' && call.url.endsWith('/pulls'));
      assert.match(prCall.body, /"head":"feature\/x"/);
      assert.match(prCall.body, /"base":"main"/);
    });
  } finally { globalThis.fetch = original; }
});

test('github tools: fail closed when no token/connection is configured', async () => {
  await withEnv({ GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, async () => {
    const registry = createLiveToolRegistry();
    await assert.rejects(() => registry.run('github.repo', { repo: 'o/r' }), /GITHUB_NOT_CONFIGURED/);
    await assert.rejects(() => registry.run('github.pr.create', { repo: 'o/r', title: 'T', head: 'h', base: 'main' }), /GITHUB_NOT_CONFIGURED/);
  });
});

/* -------------------------------------------------------------------------- */
/*  Notification connectors over real HTTP                                     */
/* -------------------------------------------------------------------------- */

test('notification connectors: deliver over real TCP and sign the generic webhook', async () => {
  const srv = await startServer((_req, res) => json(res, 200, { ok: true, id: 'n1' }));
  try {
    await withEnv({
      SLACK_WEBHOOK_URL: `${srv.url}/slack`, TEAMS_WEBHOOK_URL: `${srv.url}/teams`,
      DISCORD_WEBHOOK_URL: `${srv.url}/discord`, GENERIC_WEBHOOK_URL: `${srv.url}/hook`, GENERIC_WEBHOOK_SECRET: 'whsec_123456',
    }, async () => {
      const registry = createLiveToolRegistry();
      const status = registry.status();
      for (const id of ['slack.post', 'teams.post', 'discord.post', 'webhook.post']) assert.equal(status.tools.find((tool) => tool.id === id).state, 'live', `${id} must be live`);
      assert.equal((await registry.run('slack.post', { text: 'hello slack' })).output.delivered, true);
      assert.equal((await registry.run('teams.post', { text: 'hello teams', title: 'Title' })).output.delivered, true);
      assert.equal((await registry.run('discord.post', { text: 'hello discord' })).output.delivered, true);
      assert.equal((await registry.run('webhook.post', { text: 'event body', event: 'run.finished' })).output.delivered, true);
    });
    assert.equal(srv.requests.length, 4);
    const slack = srv.requests.find((request) => request.url === '/slack');
    assert.equal(slack.method, 'POST');
    assert.match(slack.body, /hello slack/);
    const hook = srv.requests.find((request) => request.url === '/hook');
    assert.equal(hook.headers['x-connector-signature'], 'whsec_123456');
    assert.match(hook.body, /run\.finished/);
  } finally { await srv.close(); }
});

test('notification connectors: fail closed with a stable code when unconfigured', async () => {
  await withEnv({ SLACK_WEBHOOK_URL: undefined, SLACK_BOT_TOKEN: undefined, TEAMS_WEBHOOK_URL: undefined, DISCORD_WEBHOOK_URL: undefined, GENERIC_WEBHOOK_URL: undefined }, async () => {
    const registry = createLiveToolRegistry();
    await assert.rejects(() => registry.run('slack.post', { text: 'x' }), /TOOL_CONNECTOR_NOT_CONFIGURED:slack\.post/);
    await assert.rejects(() => registry.run('teams.post', { text: 'x' }), /TOOL_CONNECTOR_NOT_CONFIGURED:teams\.post/);
    await assert.rejects(() => registry.run('webhook.post', { text: 'x' }), /TOOL_CONNECTOR_NOT_CONFIGURED:webhook\.post/);
  });
});

test('notion connector: creates a page against a stubbed API with the configured parent', async () => {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init = {}) => { captured = { url: String(url), body: init.body, headers: init.headers }; return new Response(JSON.stringify({ id: 'page_1', url: 'https://notion.so/page_1' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    await withEnv({ NOTION_API_KEY: 'secret_notion_key', NOTION_DATABASE_ID: 'db_123' }, async () => {
      const registry = createLiveToolRegistry();
      const page = await registry.run('notion.page.create', { title: 'Run Report', content: 'body text' });
      assert.equal(page.output.pageId, 'page_1');
    });
    assert.match(captured.url, /api\.notion\.com\/v1\/pages/);
    assert.match(captured.body, /"database_id":"db_123"/);
    assert.match(captured.headers.authorization, /Bearer secret_notion_key/);
  } finally { globalThis.fetch = original; }
});

/* -------------------------------------------------------------------------- */
/*  Long-term memory (real SQLite store)                                       */
/* -------------------------------------------------------------------------- */

test('memory tools: persist and retrieve durable project context through the real store', async () => {
  const dir = await temp();
  const db = new Database(path.join(dir, 'mem.sqlite'));
  try {
    const t = now();
    db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', 't1', 'Tenant', t);
    db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', 'u1', 't1', 'o@example.test', 'x', 'owner', t);
    db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', 'p1', 't1', 'u1', 'Project', t);
    const registry = createLiveToolRegistry({ db });
    assert.equal(registry.status().tools.find((tool) => tool.id === 'memory.search').state, 'live');
    const ctx = { run: { tenant_id: 't1' }, task: { project_id: 'p1' } };
    const written = await registry.run('memory.write', { content: 'the deployment uses a blue-green rollout strategy', source: 'run' }, ctx);
    assert.ok(written.output.id);
    const found = await registry.run('memory.search', { query: 'blue-green deployment strategy' }, ctx);
    assert.ok(found.output.results.some((result) => /blue-green/.test(result.content)));
    // Without run/task context the tool refuses instead of writing to a wrong scope.
    await assert.rejects(() => registry.run('memory.write', { content: 'x' }, {}), /MEMORY_CONTEXT_REQUIRED/);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------------------- */
/*  Document + web extraction                                                  */
/* -------------------------------------------------------------------------- */

test('doc.extract: reads plain text and a real .docx container', async () => {
  const dir = await temp();
  try {
    await writeFile(path.join(dir, 'notes.txt'), 'plain text body');
    await mkdir(path.join(dir, 'src', 'word'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'word', 'document.xml'), '<w:document><w:body><w:p><w:r><w:t>Hello docx world</w:t></w:r></w:p></w:body></w:document>');
    await run('zip', ['-q', '-r', path.join(dir, 'doc.docx'), 'word'], { cwd: path.join(dir, 'src') });
    const registry = createLiveToolRegistry();
    const txt = await registry.run('doc.extract', { path: 'notes.txt' }, { workspaceRoot: dir });
    assert.equal(txt.output.method, 'read');
    assert.match(txt.output.text, /plain text body/);
    const docx = await registry.run('doc.extract', { path: 'doc.docx' }, { workspaceRoot: dir });
    assert.equal(docx.output.method, 'unzip');
    assert.match(docx.output.text, /Hello docx world/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('web.extract: structured extraction from real HTML bytes', () => {
  const html = '<!doctype html><html><head><title>Demo Page</title><meta name="description" content="A demo"><link rel="canonical" href="https://example.test/"><script type="application/ld+json">{"@type":"Article","name":"Demo"}</script></head><body><h1>Heading One</h1><h2>Sub</h2><a href="https://example.test/a">Link A</a><a href="#skip">Skip</a><p>Body text here.</p></body></html>';
  const out = extractStructured('https://example.test/', html);
  assert.equal(out.title, 'Demo Page');
  assert.equal(out.description, 'A demo');
  assert.equal(out.canonical, 'https://example.test/');
  assert.deepEqual(out.headings.map((heading) => heading.text), ['Heading One', 'Sub']);
  assert.ok(out.links.some((link) => link.href === 'https://example.test/a'));
  assert.ok(!out.links.some((link) => link.href === '#skip'));
  assert.equal(out.jsonLd[0].name, 'Demo');
  assert.match(out.text, /Body text here/);
});

test('web.extract: refuses a loopback/private target (SSRF fail-closed)', async () => {
  const registry = createLiveToolRegistry();
  await assert.rejects(() => registry.run('web.extract', { url: 'http://127.0.0.1:9/' }), /SSRF_TARGET_NOT_ALLOWED/);
  await assert.rejects(() => registry.run('web.extract', { url: 'http://169.254.169.254/latest/meta-data/' }), /SSRF_TARGET_NOT_ALLOWED/);
});

/* -------------------------------------------------------------------------- */
/*  Code review (LLM reasoning)                                                */
/* -------------------------------------------------------------------------- */

test('code.review: returns structured findings from the configured LLM', async () => {
  const llm = { async complete() { return { text: '{"summary":"looks fine","findings":[{"severity":"low","file":"a.txt","issue":"style","suggestion":"tidy"}],"verdict":"approve"}', usage: { totalTokens: 3 } }; } };
  const registry = createLiveToolRegistry({ llm });
  assert.equal(registry.status().tools.find((tool) => tool.id === 'code.review').state, 'live');
  const out = await registry.run('code.review', { diff: 'diff --git a/a.txt b/a.txt\n+x' }, { model: 'test' });
  assert.equal(out.output.review.verdict, 'approve');
  assert.equal(out.output.review.findings[0].severity, 'low');
});

test('code.review: refuses when there is nothing to review', async () => {
  const llm = { async complete() { return { text: '{}' }; } };
  const registry = createLiveToolRegistry({ llm });
  await assert.rejects(() => registry.run('code.review', {}, {}), /CODE_REVIEW_NO_INPUT/);
});
