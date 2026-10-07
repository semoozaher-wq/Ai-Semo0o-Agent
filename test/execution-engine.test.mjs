import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  Capability,
  PermissionDeniedError,
  createExecutionEngine,
} from '../execution-core/engine.mjs';

const ALL_CAPABILITIES = Object.values(Capability);

async function fixture(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `semo0o-${name}-`));
  const evidence = path.join(root, '.test-evidence');
  return {
    root,
    evidence,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function engineFor(root, grants = ALL_CAPABILITIES, evidenceDirectory) {
  return createExecutionEngine({
    workspacePath: root,
    evidenceDirectory: evidenceDirectory ?? path.join(root, '.test-evidence'),
    grants,
    limits: { timeoutMs: 5_000, maxOutputBytes: 16_384, memoryLimitMb: 8_192, cpuLimitSeconds: 10 },
  });
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function initializeGit(root) {
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'tests@example.invalid']);
  git(root, ['config', 'user.name', 'Execution Runtime Tests']);
  await writeFile(path.join(root, 'tracked.txt'), 'base\n', 'utf8');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'base']);
}

test('permission gateway is default-deny', async () => {
  const fx = await fixture('permissions');
  try {
    await writeFile(path.join(fx.root, 'a.txt'), 'A', 'utf8');
    const engine = await engineFor(fx.root, [], fx.evidence);
    await assert.rejects(
      () => engine.files.read('a.txt'),
      (error) => error instanceof PermissionDeniedError && error.code === 'PERMISSION_DENIED',
    );
  } finally {
    await fx.cleanup();
  }
});

test('real file engine blocks traversal and symlink escape while keeping writes atomic', async () => {
  const fx = await fixture('files');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'semo0o-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8');
    const engine = await engineFor(fx.root, [Capability.FILE_READ, Capability.FILE_WRITE], fx.evidence);

    const written = await engine.files.write('nested/example.txt', 'first');
    assert.equal(written.created, true);
    assert.equal((await engine.files.read('nested/example.txt')).content, 'first');
    await assert.rejects(() => engine.files.write('../escape.txt', 'no'), /forbidden|escapes/i);

    await symlink(path.join(outside, 'secret.txt'), path.join(fx.root, 'link.txt'));
    await assert.rejects(() => engine.files.read('link.txt'), /symlink|regular files/i);
    assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
  } finally {
    await fx.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('terminal execution uses command allow-list, timeout, output cap, and permission checks', async () => {
  const fx = await fixture('terminal');
  try {
    const engine = await engineFor(fx.root, [Capability.TERMINAL_EXECUTE], fx.evidence);
    const success = await engine.terminal.run({ command: 'node', args: ['-e', 'console.log("ok")'] });
    assert.equal(success.ok, true);
    assert.match(success.stdout, /ok/);
    assert.equal(success.resourceLimits.timeout, true);
    assert.equal(success.resourceLimits.output, true);

    const timedOut = await engine.terminal.run({
      command: 'node',
      args: ['-e', 'setTimeout(() => console.log("late"), 5000)'],
      timeoutMs: 50,
    });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.timedOut, true);

    await assert.rejects(
      () => engine.terminal.run({ command: 'sh', args: ['-c', 'echo unsafe'] }),
      /allow-listed/i,
    );
    await assert.rejects(
      () => engine.terminal.run({ command: 'node', args: ['-e', '0'], needsNetwork: true }),
      (error) => error instanceof PermissionDeniedError && error.details.capability === Capability.NETWORK,
    );
  } finally {
    await fx.cleanup();
  }
});

test('sandboxed commands never inherit server secrets and pin HOME/TMPDIR', async () => {
  const fx = await fixture('env');
  process.env.SEMO0O_TEST_API_KEY = 'sk-server-secret';
  try {
    const engine = await engineFor(fx.root, [Capability.TERMINAL_EXECUTE], fx.evidence);
    const result = await engine.terminal.run({
      command: 'node',
      args: [
        '-e',
        'console.log(JSON.stringify({ inherited: process.env.SEMO0O_TEST_API_KEY ?? null, denied: process.env.SEMO0O_REQUEST_SECRET ?? null, allowed: process.env.SEMO0O_SAFE ?? null, home: process.env.HOME, tmp: process.env.TMPDIR, nodeEnv: process.env.NODE_ENV }))',
      ],
      env: { SEMO0O_REQUEST_SECRET: 'leak', SEMO0O_SAFE: 'ok' },
    });
    assert.equal(result.ok, true);
    const seen = JSON.parse(result.stdout.trim());
    assert.equal(seen.inherited, null, 'an inherited server secret must not reach the sandbox');
    assert.equal(seen.denied, null, 'a denied request env var must be dropped');
    assert.equal(seen.allowed, 'ok');
    assert.equal(seen.home, engine.files.root);
    assert.equal(seen.tmp, path.join(engine.files.root, '.tmp'));
    assert.equal(seen.nodeEnv, 'production');
  } finally {
    delete process.env.SEMO0O_TEST_API_KEY;
    await fx.cleanup();
  }
});

test('real Git engine creates an independent task branch and protects the default branch', async () => {
  const fx = await fixture('branch');
  try {
    await initializeGit(fx.root);
    const engine = await engineFor(fx.root, ALL_CAPABILITIES, fx.evidence);
    const mainTip = git(fx.root, ['rev-parse', 'main']);

    const created = await engine.git.createBranch('semo0o/task/abc');
    assert.equal(created.created, true);
    assert.equal((await engine.git.branch()).branch, 'semo0o/task/abc');
    assert.ok((await engine.git.listBranches()).branches.includes('semo0o/task/abc'));

    // Idempotent: re-creating the same branch just checks it out.
    const again = await engine.git.createBranch('semo0o/task/abc');
    assert.equal(again.created, false);

    // The protected default branch is untouched.
    assert.equal(git(fx.root, ['rev-parse', 'main']), mainTip);

    await assert.rejects(() => engine.git.createBranch('main'), (error) => error.code === 'DEFAULT_BRANCH_FORBIDDEN');
    await assert.rejects(() => engine.git.createBranch('master'), (error) => error.code === 'DEFAULT_BRANCH_FORBIDDEN');
    await assert.rejects(() => engine.git.createBranch('bad name'), (error) => error.code === 'INVALID_BRANCH');
  } finally {
    await fx.cleanup();
  }
});

test('checkpoint never stages run evidence or scratch files', async () => {
  const fx = await fixture('evidence-exclude');
  try {
    await initializeGit(fx.root);
    const engine = await engineFor(fx.root, ALL_CAPABILITIES, fx.evidence);
    await engine.files.write('tracked.txt', 'changed\n');
    const checkpoint = await engine.git.checkpoint('exclude evidence test');
    assert.equal(checkpoint.created, true);
    const committed = git(fx.root, ['show', '--name-only', '--pretty=format:', 'HEAD']);
    assert.match(committed, /tracked\.txt/);
    assert.doesNotMatch(committed, /\.test-evidence/);
  } finally {
    await fx.cleanup();
  }
});

test('checkpoint excludes the whole evidence container, including earlier runs', async () => {
  const fx = await fixture('evidence-container');
  try {
    await initializeGit(fx.root);
    // Evidence left behind by an earlier run in the default container layout.
    const staleRun = path.join(fx.root, '.semo0o-evidence', 'earlier-run');
    await mkdir(staleRun, { recursive: true });
    await writeFile(path.join(staleRun, 'manifest.json'), '{"stale":true}', 'utf8');

    // A fresh run uses the default evidence directory (<root>/.semo0o-evidence/<uuid>).
    const engine = await createExecutionEngine({ workspacePath: fx.root, grants: ALL_CAPABILITIES });
    await engine.files.write('tracked.txt', 'changed\n');
    const checkpoint = await engine.git.checkpoint('exclude whole evidence container');
    assert.equal(checkpoint.created, true);

    const committed = git(fx.root, ['show', '--name-only', '--pretty=format:', 'HEAD']);
    assert.match(committed, /tracked\.txt/);
    assert.doesNotMatch(committed, /\.semo0o-evidence/);
    // The stale evidence stays on disk, it is just never committed.
    assert.equal(await readFile(path.join(staleRun, 'manifest.json'), 'utf8'), '{"stale":true}');
  } finally {
    await fx.cleanup();
  }
});

test('real Git engine reports state, checkpoints changes, and rolls back a revision', async () => {
  const fx = await fixture('git');
  try {
    await initializeGit(fx.root);
    const engine = await engineFor(fx.root, ALL_CAPABILITIES, fx.evidence);

    assert.equal((await engine.git.branch()).branch, 'main');
    await engine.files.write('tracked.txt', 'checkpointed\n');
    assert.match((await engine.git.status()).stdout, /tracked.txt/);
    const checkpoint = await engine.git.checkpoint('checkpoint test change');
    assert.equal(checkpoint.created, true);
    assert.match(checkpoint.revision, /^[0-9a-f]{40}$/);

    await engine.files.write('tracked.txt', 'broken\n');
    assert.match((await engine.git.diff()).stdout, /broken/);
    await engine.git.rollback(checkpoint.revision);
    assert.equal(await readFile(path.join(fx.root, 'tracked.txt'), 'utf8'), 'checkpointed\n');
  } finally {
    await fx.cleanup();
  }
});

test('verification failure restores only agent-touched files and writes evidence', async () => {
  const fx = await fixture('rollback');
  try {
    await writeFile(path.join(fx.root, 'existing.txt'), 'original', 'utf8');
    const engine = await engineFor(fx.root, ALL_CAPABILITIES, fx.evidence);
    const result = await engine.executeTransaction({
      operations: [
        { type: 'write', path: 'existing.txt', content: 'broken' },
        { type: 'write', path: 'new.txt', content: 'new content' },
      ],
      verification: [{ command: 'node', args: ['-e', 'process.exit(7)'] }],
    });

    assert.equal(result.state, 'failed_rolled_back');
    assert.equal(result.rollback.ok, true);
    assert.equal(await readFile(path.join(fx.root, 'existing.txt'), 'utf8'), 'original');
    await assert.rejects(() => readFile(path.join(fx.root, 'new.txt'), 'utf8'));
    const evidence = JSON.parse(await readFile(path.join(fx.evidence, 'result.json'), 'utf8'));
    assert.equal(evidence.state, 'failed_rolled_back');
  } finally {
    await fx.cleanup();
  }
});

test('self-healing callback replans once, reruns real verification, and only then returns verified', async () => {
  const fx = await fixture('replan');
  try {
    await mkdir(path.join(fx.root, 'src'));
    await writeFile(path.join(fx.root, 'src', 'value.txt'), 'initial', 'utf8');
    const engine = await engineFor(fx.root, ALL_CAPABILITIES, fx.evidence);
    let replans = 0;
    const result = await engine.executeTransaction({
      maxAttempts: 2,
      operations: [{ type: 'write', path: 'src/value.txt', content: 'wrong' }],
      verification: [
        {
          command: 'node',
          args: [
            '-e',
            "if (require('node:fs').readFileSync('src/value.txt', 'utf8') !== 'fixed') process.exit(2)",
          ],
        },
      ],
      replan: async ({ failure }) => {
        replans += 1;
        assert.equal(failure.kind, 'command_failed');
        return {
          operations: [{ type: 'patch', path: 'src/value.txt', expected: 'initial', replacement: 'fixed' }],
          verification: [
            {
              command: 'node',
              args: [
                '-e',
                "if (require('node:fs').readFileSync('src/value.txt', 'utf8') !== 'fixed') process.exit(2)",
              ],
            },
          ],
        };
      },
    });

    assert.equal(replans, 1);
    assert.equal(result.state, 'verified');
    assert.equal(result.attempts, 2);
    assert.equal(await readFile(path.join(fx.root, 'src', 'value.txt'), 'utf8'), 'fixed');
  } finally {
    await fx.cleanup();
  }
});
