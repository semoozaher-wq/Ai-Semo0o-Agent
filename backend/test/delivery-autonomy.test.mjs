import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';

import { createExecutionEngine, Capability } from '../../execution-core/engine.mjs';
import { createGitHubClient } from '../github/service.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { Database, id, now } from '../db/client.mjs';

/**
 * Autonomous software delivery: the push leg is proven against a REAL local bare
 * repository (actual git object transfer), the protected-branch refusal is
 * proven, and the GitHub legs (CI logs, PR verify, rerun, merge) are proven
 * against a stubbed GitHub API that exercises the real request shaping, redirect
 * handling, archive unzip and verdict logic.
 */

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-push-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'a@example.invalid']);
  git(root, ['config', 'user.name', 'Agent']);
  await writeFile(path.join(root, 'README.md'), '# hello\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

const GRANTS = [Capability.FILE_READ, Capability.FILE_WRITE, Capability.GIT_READ, Capability.GIT_WRITE, Capability.NETWORK];

test('git.push pushes a task branch to a real local remote (never the default branch)', async () => {
  const bare = await mkdtemp(path.join(os.tmpdir(), 'semo0o-bare-'));
  const work = await makeRepo();
  try {
    git(bare, ['init', '--bare', '--initial-branch=main']);
    git(work, ['checkout', '-b', 'semo0o/task/42']);
    await writeFile(path.join(work, 'feature.txt'), 'work\n', 'utf8');
    git(work, ['add', 'feature.txt']);
    git(work, ['commit', '-m', 'feature']);
    git(work, ['remote', 'add', 'origin', bare]);

    const engine = await createExecutionEngine({ workspacePath: work, grants: GRANTS });
    const result = await engine.git.push('origin', 'semo0o/task/42');
    assert.equal(result.pushed, true);
    assert.equal(result.branch, 'semo0o/task/42');

    // The branch really exists in the remote and carries the commit.
    const branches = git(bare, ['branch', '--list']);
    assert.match(branches, /semo0o\/task\/42/);
    const remoteLog = git(bare, ['log', 'semo0o/task/42', '--pretty=format:%s']);
    assert.match(remoteLog, /feature/);
  } finally {
    await rm(bare, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('git.push refuses to push the protected default branch', async () => {
  const bare = await mkdtemp(path.join(os.tmpdir(), 'semo0o-bare2-'));
  const work = await makeRepo();
  try {
    git(bare, ['init', '--bare', '--initial-branch=main']);
    git(work, ['remote', 'add', 'origin', bare]);
    const engine = await createExecutionEngine({ workspacePath: work, grants: GRANTS });
    await assert.rejects(() => engine.git.push('origin', 'main'), (error) => error.code === 'DEFAULT_BRANCH_FORBIDDEN');
  } finally {
    await rm(bare, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test('git.push rejects a raw URL remote (only named remotes are allowed)', async () => {
  const work = await makeRepo();
  try {
    const engine = await createExecutionEngine({ workspacePath: work, grants: GRANTS });
    await assert.rejects(() => engine.git.push('https://evil.example/repo.git', 'semo0o/task/1'), (error) => error.code === 'INVALID_REMOTE_NAME');
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/*  GitHub delivery legs (stubbed API, real client code)                      */
/* -------------------------------------------------------------------------- */

function stubFetch(routes) {
  const real = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const parsed = new URL(url);
    const method = String(init.method || 'GET').toUpperCase();
    // The client percent-encodes refs (e.g. branch names with slashes), so match
    // both the raw and the decoded pathname against the stub table.
    const candidates = [parsed.pathname, decodeURIComponent(parsed.pathname)];
    let handler;
    for (const key of candidates) {
      handler = routes[`${method} ${key}`] ?? routes[key];
      if (handler) break;
    }
    if (!handler) throw new Error(`UNSTUBBED ${method} ${parsed.pathname}`);
    const result = typeof handler === 'function' ? await handler({ url: parsed, init, method }) : handler;
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result.body ?? result), { status: result.status ?? 200, headers: { 'content-type': 'application/json', ...(result.headers ?? {}) } });
  };
  return () => { global.fetch = real; };
}

test('github client: verifyPullRequest combines state, reviews and checks into a verdict', async () => {
  const restore = stubFetch({
    'GET /repos/o/r/pulls/7': { number: 7, title: 'Fix', state: 'open', merged: false, mergeable: true, head: { ref: 'semo0o/task/7' }, base: { ref: 'main' }, html_url: 'https://github.com/o/r/pull/7' },
    'GET /repos/o/r/pulls/7/reviews': [{ id: 1, user: { login: 'rev' }, state: 'APPROVED', body: 'lgtm' }],
    'GET /repos/o/r/pulls/7/files': [{ filename: 'a.js', status: 'modified', additions: 3, deletions: 1, changes: 4 }],
    'GET /repos/o/r/commits/semo0o/task/7/status': { state: 'success', total_count: 1, statuses: [] },
    'GET /repos/o/r/commits/semo0o/task/7/check-runs': { total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] },
  });
  try {
    const client = createGitHubClient({ token: 'gh_test' });
    const result = await client.verifyPullRequest({ owner: 'o', repo: 'r', number: 7 });
    assert.equal(result.verdict, 'ready');
    assert.equal(result.green, true);
    assert.equal(result.approvals, 1);
    assert.equal(result.files.length, 1);
  } finally { restore(); }
});

test('github client: verifyPullRequest reports failing checks', async () => {
  const restore = stubFetch({
    'GET /repos/o/r/pulls/8': { number: 8, state: 'open', merged: false, mergeable: true, head: { ref: 'semo0o/task/8' }, base: { ref: 'main' } },
    'GET /repos/o/r/pulls/8/reviews': [],
    'GET /repos/o/r/pulls/8/files': [],
    'GET /repos/o/r/commits/semo0o/task/8/status': { state: 'failure', total_count: 1, statuses: [] },
    'GET /repos/o/r/commits/semo0o/task/8/check-runs': { total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'failure' }] },
  });
  try {
    const client = createGitHubClient({ token: 'gh_test' });
    const result = await client.verifyPullRequest({ owner: 'o', repo: 'r', number: 8 });
    assert.equal(result.verdict, 'failing');
    assert.deepEqual(result.failing, ['ci']);
  } finally { restore(); }
});

test('github client: downloadWorkflowRunLogs follows the redirect and unzips the archive', async () => {
  const zip = new JSZip();
  zip.file('build/1_test.txt', 'step: run tests\nERROR: 2 tests failed\n');
  zip.file('build/2_build.txt', 'build ok\n');
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const restore = stubFetch({
    'GET /repos/o/r/actions/runs/5/logs': new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/o/r/logs' } }),
    'GET /o/r/logs': new Response(zipBuffer, { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  try {
    const client = createGitHubClient({ token: 'gh_test' });
    const result = await client.downloadWorkflowRunLogs({ owner: 'o', repo: 'r', runId: 5 });
    assert.equal(result.files.length, 2);
    const testLog = result.files.find((file) => file.name.includes('1_test'));
    assert.match(testLog.text, /2 tests failed/);
  } finally { restore(); }
});

test('github client: downloadWorkflowRunLogs blocks a redirect to a non-GitHub host', async () => {
  const restore = stubFetch({
    'GET /repos/o/r/actions/runs/6/logs': new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
  });
  try {
    const client = createGitHubClient({ token: 'gh_test' });
    await assert.rejects(() => client.downloadWorkflowRunLogs({ owner: 'o', repo: 'r', runId: 6 }), /GITHUB_LOG_REDIRECT_BLOCKED/);
  } finally { restore(); }
});

test('github client: mergePullRequest and rerunWorkflowRun issue the right calls', async () => {
  const calls = [];
  const restore = stubFetch({
    'PUT /repos/o/r/pulls/9/merge': (ctx) => { calls.push(`merge:${ctx.init.body}`); return { merged: true, sha: 'abc123', message: 'merged' }; },
    'POST /repos/o/r/actions/runs/5/rerun': () => { calls.push('rerun'); return {}; },
    'POST /repos/o/r/actions/runs/5/rerun-failed-jobs': () => { calls.push('rerun-failed'); return {}; },
  });
  try {
    const client = createGitHubClient({ token: 'gh_test' });
    const merged = await client.mergePullRequest({ owner: 'o', repo: 'r', number: 9, method: 'squash' });
    assert.equal(merged.merged, true);
    assert.match(calls[0], /"merge_method":"squash"/);
    await client.rerunWorkflowRun({ owner: 'o', repo: 'r', runId: 5 });
    await client.rerunFailedJobs({ owner: 'o', repo: 'r', runId: 5 });
    assert.deepEqual(calls.slice(1), ['rerun', 'rerun-failed']);
  } finally { restore(); }
});

/* -------------------------------------------------------------------------- */
/*  Registry integration                                                      */
/* -------------------------------------------------------------------------- */

function seedRun(db) {
  const t = now();
  const tenantId = id('tenant'); const userId = id('user'); const projectId = id('project');
  const workspaceId = id('workspace'); const taskId = id('task'); const runId = id('run');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'T', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'a@t', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'P', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'g', 'running', t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'running', '{}', 0, t, t);
  return { runId, tenantId };
}

test('registry: delivery tools are registered and fail closed without GitHub config', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-deliv-'));
  try {
    const db = new Database(path.join(dir, 'd.sqlite'));
    const registry = createLiveToolRegistry({ db, codeRunner: null, tavily: null, llm: null, engineAvailable: true, memory: null });
    const status = registry.status();
    for (const toolId of ['git.push', 'github.ci.logs', 'github.ci.rerun', 'github.pr.verify', 'github.pr.merge']) {
      assert.ok(status.tools.some((tool) => tool.id === toolId), `${toolId} missing from status`);
    }
    assert.ok(status.unwired.includes('github.pr.verify'));
    await assert.rejects(() => registry.run('github.pr.verify', { repo: 'o/r', number: 1 }, {}), /GITHUB_NOT_CONFIGURED/);
    await assert.rejects(() => registry.run('git.push', {}, {}), /ENGINE_REQUIRED/);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registry: github.pr.verify runs end to end with a configured token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-deliv2-'));
  const restore = stubFetch({
    'GET /repos/o/r/pulls/3': { number: 3, state: 'open', merged: false, mergeable: true, head: { ref: 'semo0o/task/3' }, base: { ref: 'main' } },
    'GET /repos/o/r/pulls/3/reviews': [],
    'GET /repos/o/r/pulls/3/files': [],
    'GET /repos/o/r/commits/semo0o/task/3/status': { state: 'success', total_count: 0, statuses: [] },
    'GET /repos/o/r/commits/semo0o/task/3/check-runs': { total_count: 0, check_runs: [] },
  });
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'gh_test';
  try {
    const db = new Database(path.join(dir, 'd.sqlite'));
    const registry = createLiveToolRegistry({ db, codeRunner: null, tavily: null, llm: null, engineAvailable: true, memory: null });
    const result = await registry.run('github.pr.verify', { repo: 'o/r', number: 3 }, {});
    assert.equal(result.output.verdict, 'ready');
    db.close();
  } finally {
    restore();
    if (previous === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
