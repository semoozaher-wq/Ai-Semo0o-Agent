import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDefaultBranch } from '../execution-core/engine.mjs';
import {
  DEFAULT_TASK_BRANCH_PREFIX,
  provisionTaskWorkspace,
  taskBranchName,
  taskGitBranch,
  taskGitDiff,
  taskGitStatus,
} from '../execution-core/task-workspace.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeSourceRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-src-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'src@example.invalid']);
  git(root, ['config', 'user.name', 'Source']);
  await writeFile(path.join(root, 'README.md'), '# source\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

async function makeBase() {
  return mkdtemp(path.join(os.tmpdir(), 'semo0o-tasks-'));
}

test('provisionTaskWorkspace clones an isolated per-task checkout on a task branch', async () => {
  const source = await makeSourceRepo();
  const base = await makeBase();
  try {
    const handle = await provisionTaskWorkspace({ taskId: 'task-1', repo: source, baseRoot: base });

    assert.equal(handle.branch, `${DEFAULT_TASK_BRANCH_PREFIX}task-1`);
    assert.equal(handle.branchCreated, true);
    assert.equal(handle.workspacePath, path.join(base, 'task-1', 'workspace'));
    assert.ok(handle.evidenceDirectory.startsWith(path.join(base, 'task-1', 'evidence')));
    // Evidence must never live inside the Git tree, or checkpoints would stage it.
    assert.ok(!handle.evidenceDirectory.startsWith(handle.workspacePath));

    // A real Git checkout exists on the task branch.
    assert.equal(git(handle.workspacePath, ['rev-parse', '--is-inside-work-tree']), 'true');
    assert.equal(git(handle.workspacePath, ['branch', '--show-current']), `${DEFAULT_TASK_BRANCH_PREFIX}task-1`);

    // status / diff are exposed through the engine.
    const status = await taskGitStatus(handle);
    assert.equal(status.ok, true);
    assert.match(status.stdout, /semo0o\/task\/task-1/);
    const diff = await taskGitDiff(handle);
    assert.equal(diff.ok, true);
    assert.equal((await taskGitBranch(handle)).branch, `${DEFAULT_TASK_BRANCH_PREFIX}task-1`);

    // The protected default branch is untouched: it still points at the source tip.
    assert.equal(git(handle.workspacePath, ['rev-parse', 'main']), git(source, ['rev-parse', 'main']));
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

test('each task gets its own directory and branch, and master is never modified', async () => {
  const source = await makeSourceRepo();
  const base = await makeBase();
  try {
    const one = await provisionTaskWorkspace({ taskId: 'alpha', repo: source, baseRoot: base });
    const two = await provisionTaskWorkspace({ taskId: 'beta', repo: source, baseRoot: base });

    assert.notEqual(one.workspacePath, two.workspacePath);
    assert.equal(one.branch, `${DEFAULT_TASK_BRANCH_PREFIX}alpha`);
    assert.equal(two.branch, `${DEFAULT_TASK_BRANCH_PREFIX}beta`);

    // Write to task one only; task two and the source stay clean.
    await writeFile(path.join(one.workspacePath, 'alpha.txt'), 'alpha\n', 'utf8');
    const oneStatus = await taskGitStatus(one);
    assert.match(oneStatus.stdout, /alpha\.txt/);
    const twoStatus = await taskGitStatus(two);
    assert.doesNotMatch(twoStatus.stdout, /alpha\.txt/);

    // master/main in every checkout still equals the source tip.
    const sourceTip = git(source, ['rev-parse', 'main']);
    assert.equal(git(one.workspacePath, ['rev-parse', 'main']), sourceTip);
    assert.equal(git(two.workspacePath, ['rev-parse', 'main']), sourceTip);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

test('provisioning without a remote initialises a repository and still branches', async () => {
  const base = await makeBase();
  try {
    const handle = await provisionTaskWorkspace({ taskId: 'empty-task', baseRoot: base });
    assert.equal(handle.clone, null);
    assert.equal(git(handle.workspacePath, ['rev-parse', '--is-inside-work-tree']), 'true');
    assert.equal(git(handle.workspacePath, ['branch', '--show-current']), `${DEFAULT_TASK_BRANCH_PREFIX}empty-task`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('re-provisioning refuses a populated workspace unless explicitly allowed', async () => {
  const base = await makeBase();
  try {
    await provisionTaskWorkspace({ taskId: 'dup', baseRoot: base });
    await assert.rejects(
      () => provisionTaskWorkspace({ taskId: 'dup', baseRoot: base }),
      /WORKSPACE_EXISTS/,
    );
    const reused = await provisionTaskWorkspace({ taskId: 'dup', baseRoot: base, allowExisting: true });
    assert.equal(reused.branchCreated, false);
    assert.equal(reused.branch, `${DEFAULT_TASK_BRANCH_PREFIX}dup`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the protected default branch can never be used as a task branch', async () => {
  const base = await makeBase();
  try {
    await assert.rejects(
      () => provisionTaskWorkspace({ taskId: 'x', baseRoot: base, branch: 'main' }),
      /DEFAULT_BRANCH_FORBIDDEN/,
    );
    await assert.rejects(
      () => provisionTaskWorkspace({ taskId: 'x', baseRoot: base, branch: 'master' }),
      /DEFAULT_BRANCH_FORBIDDEN/,
    );
    assert.equal(isDefaultBranch('main'), true);
    assert.equal(isDefaultBranch('master'), true);
    assert.equal(isDefaultBranch('semo0o/task/x'), false);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('the runtime performs no automatic push or merge', async () => {
  const base = await makeBase();
  try {
    const handle = await provisionTaskWorkspace({ taskId: 'no-push', baseRoot: base });
    // `push` now exists as an EXPLICIT, capability-gated operation (the `git.push`
    // tool refuses protected branches and raw URLs), but it is never invoked
    // automatically and `merge`/`pull` do not exist at all.
    assert.equal(typeof handle.engine.git.push, 'function');
    assert.equal(typeof handle.engine.git.merge, 'undefined');
    assert.equal(typeof handle.engine.git.pull, 'undefined');
    // A local branch is created, but no remote is configured and nothing is pushed.
    assert.equal(git(handle.workspacePath, ['remote']), '');
    // The evidence manifest records the lifecycle but never a push/merge command.
    const manifest = JSON.parse(await readFile(path.join(handle.evidenceDirectory, 'manifest.json'), 'utf8'));
    const commands = manifest.events
      .filter((event) => event.type === 'git_command')
      .map((event) => event.details.args.join(' '));
    assert.ok(commands.every((command) => !/^push|^merge|^pull/.test(command)));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('taskBranchName rejects unsafe task ids', () => {
  assert.equal(taskBranchName('task-1'), `${DEFAULT_TASK_BRANCH_PREFIX}task-1`);
  assert.throws(() => taskBranchName('../escape'), /INVALID_TASK_ID/);
  assert.throws(() => taskBranchName('has space'), /INVALID_TASK_ID/);
  assert.throws(() => taskBranchName(''), /INVALID_TASK_ID/);
});
