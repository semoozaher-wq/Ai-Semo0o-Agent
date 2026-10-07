import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeSourceRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-gh-src-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'src@example.invalid']);
  git(root, ['config', 'user.name', 'Source']);
  await writeFile(path.join(root, 'README.md'), '# source\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-taskgit-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return {
    dir, db, queue, app, base, request,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

const PASSWORD = 'correct horse battery staple';

async function login(fx, email) {
  const response = await fx.request('/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
  assert.equal(response.status, 200, `login failed for ${email}: ${JSON.stringify(response.body)}`);
  return response.body.session.token;
}

async function projectAndTask(fx, token, projectRoot) {
  const project = await fx.request('/projects', { method: 'POST', token, body: { name: 'P', rootPath: projectRoot } });
  assert.equal(project.status, 201, JSON.stringify(project.body));
  const run = await fx.request('/runs', {
    method: 'POST',
    token,
    body: { kind: 'code.run', goal: 'demo', projectId: project.body.projectId, workspaceId: project.body.workspaceId },
  });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  return { projectId: project.body.projectId, workspaceId: project.body.workspaceId, taskId: run.body.taskId };
}

test('a task is provisioned with an isolated workspace and its git state is readable', async () => {
  const source = await makeSourceRepo();
  const fx = await fixture();
  try {
    createUser(fx.db, { email: 'owner@taskgit.test', password: PASSWORD, tenantName: 'Org' });
    const token = await login(fx, 'owner@taskgit.test');
    const projectRoot = path.join(fx.dir, 'project-root');
    const { workspaceId, taskId } = await projectAndTask(fx, token, projectRoot);

    const provisioned = await fx.request(`/tasks/${taskId}/workspace`, { method: 'POST', token, body: { repo: source } });
    assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
    assert.equal(provisioned.body.branch, `semo0o/task/${taskId}`);
    assert.equal(provisioned.body.branchCreated, true);
    assert.ok(provisioned.body.workspacePath.startsWith(path.join(projectRoot, taskId)));

    // The task now points at its own isolated workspace, not the shared project one.
    const taskRow = fx.db.get('SELECT workspace_id FROM tasks WHERE id=?', taskId);
    assert.equal(taskRow.workspace_id, provisioned.body.workspaceId);
    assert.notEqual(taskRow.workspace_id, workspaceId);

    // Git state is exposed through the orchestrator API.
    const status = await fx.request(`/tasks/${taskId}/git/status`, { token });
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(status.body.ok, true);
    assert.match(status.body.stdout, new RegExp(`semo0o/task/${taskId}`));

    const diff = await fx.request(`/tasks/${taskId}/git/diff`, { token });
    assert.equal(diff.status, 200);
    assert.equal(diff.body.ok, true);

    const branch = await fx.request(`/tasks/${taskId}/git/branch`, { token });
    assert.equal(branch.body.branch, `semo0o/task/${taskId}`);

    // The protected default branch is untouched.
    assert.equal(git(provisioned.body.workspacePath, ['rev-parse', 'main']), git(source, ['rev-parse', 'main']));
  } finally {
    await fx.close();
    await rm(source, { recursive: true, force: true });
  }
});

test('git routes are tenant-scoped and the protected branch is refused', async () => {
  const source = await makeSourceRepo();
  const fx = await fixture();
  try {
    createUser(fx.db, { email: 'owner@taskgit.test', password: PASSWORD, tenantName: 'Org' });
    const token = await login(fx, 'owner@taskgit.test');
    const { taskId } = await projectAndTask(fx, token, path.join(fx.dir, 'project-root'));

    const forbidden = await fx.request(`/tasks/${taskId}/workspace`, { method: 'POST', token, body: { repo: source, branch: 'main' } });
    assert.equal(forbidden.status, 400);
    assert.equal(forbidden.body.error, 'DEFAULT_BRANCH_FORBIDDEN');

    createUser(fx.db, { email: 'other@taskgit.test', password: PASSWORD, tenantName: 'Other' });
    const otherToken = await login(fx, 'other@taskgit.test');
    const denied = await fx.request(`/tasks/${taskId}/git/status`, { token: otherToken });
    assert.equal(denied.status, 404);
  } finally {
    await fx.close();
    await rm(source, { recursive: true, force: true });
  }
});
