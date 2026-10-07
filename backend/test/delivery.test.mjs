import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Capability, createExecutionEngine } from '../../execution-core/engine.mjs';
import { provisionTaskWorkspace } from '../../execution-core/task-workspace.mjs';
import { DELIVERY_EVENTS, deliverRun, deliveryMessage } from '../agent/delivery.mjs';

const GRANTS = [
  Capability.FILE_READ,
  Capability.FILE_WRITE,
  Capability.TERMINAL_EXECUTE,
  Capability.GIT_READ,
  Capability.GIT_WRITE,
];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeSourceRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-delivery-src-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'src@example.invalid']);
  git(root, ['config', 'user.name', 'Source']);
  await writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

async function makeMainRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-delivery-main-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'src@example.invalid']);
  git(root, ['config', 'user.name', 'Source']);
  await writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('deliveryMessage is bounded, deterministic and never empty', () => {
  assert.equal(deliveryMessage('  fix   the   bug '), 'semo0o: deliver fix the bug');
  assert.equal(deliveryMessage(''), 'semo0o: deliver agent run');
  assert.equal(deliveryMessage(undefined), 'semo0o: deliver agent run');
  const long = deliveryMessage('x'.repeat(500));
  assert.ok(long.length <= 240, `message must be bounded, got ${long.length}`);
  assert.ok(long.startsWith('semo0o: deliver '));
});

test('deliverRun fails closed when the engine has no git checkout', async () => {
  assert.deepEqual(await deliverRun({ engine: {} }), { delivered: false, reason: 'no_git' });
  assert.deepEqual(await deliverRun({}), { delivered: false, reason: 'no_git' });
  assert.deepEqual(await deliverRun({ engine: { git: { checkpoint: () => {} } } }), { delivered: false, reason: 'no_git' });
});

test('deliverRun refuses the protected default branch and never commits to it', async () => {
  const root = await makeMainRepo();
  const engine = await createExecutionEngine({
    workspacePath: root,
    evidenceDirectory: path.join(root, '..', `semo0o-delivery-ev-${Date.now()}`),
    grants: GRANTS,
  });
  try {
    await writeFile(path.join(root, 'app.js'), 'module.exports = 2;\n', 'utf8');
    const headBefore = git(root, ['rev-parse', 'HEAD']);
    const result = await deliverRun({ engine, goal: 'ship it' });
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'protected_branch');
    assert.equal(result.branch, 'main');
    // Nothing was committed: the protected branch tip is unchanged.
    assert.equal(git(root, ['rev-parse', 'HEAD']), headBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('deliverRun reports nothing_to_deliver on a clean task worktree (scratch is ignored)', async () => {
  const source = await makeSourceRepo();
  const base = await mkdtemp(path.join(os.tmpdir(), 'semo0o-delivery-base-'));
  const handle = await provisionTaskWorkspace({ taskId: 'task_deliver_clean', repo: source, baseRoot: base });
  try {
    // Simulate sandbox scratch files: a non-empty .tmp must NOT count as work.
    await mkdir(path.join(handle.workspacePath, '.tmp'), { recursive: true });
    await writeFile(path.join(handle.workspacePath, '.tmp', 'scratch.tmp'), 'junk\n', 'utf8');
    const result = await deliverRun({ engine: handle.engine, goal: 'no-op' });
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'nothing_to_deliver');
    assert.equal(result.branch, `semo0o/task/task_deliver_clean`);
    assert.deepEqual(result.changed, []);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('deliverRun commits verified work to the task branch and leaves main untouched', async () => {
  const source = await makeSourceRepo();
  const base = await mkdtemp(path.join(os.tmpdir(), 'semo0o-delivery-base-'));
  const handle = await provisionTaskWorkspace({ taskId: 'task_deliver_ok', repo: source, baseRoot: base });
  try {
    const mainTip = git(handle.workspacePath, ['rev-parse', 'main']);
    const headBefore = git(handle.workspacePath, ['rev-parse', 'HEAD']);
    await writeFile(path.join(handle.workspacePath, 'app.js'), 'module.exports = 3;\n', 'utf8');

    const result = await deliverRun({ engine: handle.engine, goal: 'make the test pass' });
    assert.equal(result.delivered, true, JSON.stringify(result));
    assert.equal(result.branch, 'semo0o/task/task_deliver_ok');
    assert.ok(result.revision, 'a delivery must report the commit revision');
    assert.ok(result.changed.some((entry) => entry.includes('app.js')), JSON.stringify(result.changed));
    assert.equal(result.diff.available, true);
    assert.ok(result.diff.stdout.includes('module.exports = 3'), 'the diff artifact must contain the change');
    assert.match(result.message, /^semo0o: deliver make the test pass$/);

    // The commit really landed on the task branch...
    assert.equal(git(handle.workspacePath, ['rev-parse', 'HEAD']), result.revision);
    assert.notEqual(result.revision, headBefore);
    assert.match(git(handle.workspacePath, ['log', '-1', '--pretty=%s']), /^semo0o: deliver/);
    assert.equal(await readFile(path.join(handle.workspacePath, 'app.js'), 'utf8'), 'module.exports = 3;\n');
    // ...and the protected default branch is untouched.
    assert.equal(git(handle.workspacePath, ['rev-parse', 'main']), mainTip);
    assert.equal(git(handle.workspacePath, ['branch', '--show-current']), 'semo0o/task/task_deliver_ok');
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});

test('regression: RealGit.checkpoint ignores excluded scratch and reports clean_worktree', async () => {
  const root = await makeMainRepo();
  const engine = await createExecutionEngine({
    workspacePath: root,
    evidenceDirectory: path.join(root, '..', `semo0o-delivery-ev-${Date.now()}`),
    grants: GRANTS,
  });
  try {
    // A non-empty .tmp (sandbox scratch) used to make checkpoint attempt a commit
    // and throw GIT_COMMIT_FAILED. It must now be treated as a clean worktree.
    await mkdir(path.join(root, '.tmp'), { recursive: true });
    await writeFile(path.join(root, '.tmp', 'scratch.tmp'), 'junk\n', 'utf8');
    assert.deepEqual((await engine.git.changedEntries()).entries, []);
    const checkpoint = await engine.git.checkpoint('nothing to commit');
    assert.equal(checkpoint.created, false);
    assert.equal(checkpoint.reason, 'clean_worktree');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('DELIVERY_EVENTS exposes the lifecycle event names', () => {
  assert.equal(DELIVERY_EVENTS.completed, 'delivery_completed');
  assert.equal(DELIVERY_EVENTS.skipped, 'delivery_skipped');
  assert.equal(DELIVERY_EVENTS.failed, 'delivery_failed');
});
