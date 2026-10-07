import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Capability, createExecutionEngine } from '../execution-core/engine.mjs';
import {
  AGENT_TERMINAL_COMMANDS,
  createEngineToolHandlers,
  normalizeOperations,
  normalizeVerification,
} from '../execution-core/engine-tools.mjs';

const ALL_CAPABILITIES = Object.values(Capability);

async function fixture(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `semo0o-etools-${name}-`));
  const evidence = path.join(root, '.test-evidence');
  const engine = await createExecutionEngine({
    workspacePath: root,
    evidenceDirectory: evidence,
    grants: ALL_CAPABILITIES,
    limits: { timeoutMs: 5_000, maxOutputBytes: 16_384, memoryLimitMb: 8_192, cpuLimitSeconds: 10 },
  });
  return { root, evidence, engine, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('engine-backed file tools read, write, patch and scan inside the workspace', async () => {
  const fx = await fixture('files');
  try {
    const tools = createEngineToolHandlers();
    const context = { engine: fx.engine };

    const written = await tools['files.write']({ path: 'src/app.js', content: 'module.exports = 1;\n' }, context);
    assert.equal(written.output.created, true);

    const read = await tools['files.read']({ path: 'src/app.js' }, context);
    assert.match(read.output.content, /module.exports = 1/);

    const patched = await tools['files.patch'](
      { path: 'src/app.js', expected: 'module.exports = 1;\n', replacement: 'module.exports = 2;\n' },
      context,
    );
    assert.ok(patched.output.sha256);
    await assert.rejects(
      () => tools['files.patch']({ path: 'src/app.js', expected: 'stale', replacement: 'x' }, context),
      /PATCH_CONFLICT|changed since inspection/i,
    );

    await mkdir(path.join(fx.root, 'node_modules'), { recursive: true });
    await writeFile(path.join(fx.root, 'node_modules', 'junk.js'), 'x');
    const scan = await tools['files.scan']({ scope: '.', maxFiles: 50 }, context);
    assert.ok(scan.output.files.some((file) => file.path === 'src/app.js'));
    assert.ok(!scan.output.files.some((file) => file.path.includes('node_modules')));
  } finally {
    await fx.cleanup();
  }
});

test('agent terminal.run refuses git and non-allow-listed commands but runs node', async () => {
  const fx = await fixture('terminal');
  try {
    const tools = createEngineToolHandlers();
    const context = { engine: fx.engine };

    // Git is deliberately unreachable from a tool: no push/merge/master changes.
    await assert.rejects(
      () => tools['terminal.run']({ command: 'git', args: ['status'] }, context),
      /COMMAND_NOT_ALLOWED_FOR_AGENT:git/,
    );
    await assert.rejects(
      () => tools['terminal.run']({ command: 'sh', args: ['-c', 'echo hi'] }, context),
      /COMMAND_NOT_ALLOWED_FOR_AGENT:sh/,
    );

    const ok = await tools['terminal.run']({ command: 'node', args: ['-e', 'console.log("hello")'] }, context);
    assert.equal(ok.ok, true);
    assert.match(ok.output.stdout, /hello/);
    assert.deepEqual([...AGENT_TERMINAL_COMMANDS], ['node', 'npm', 'npx']);
  } finally {
    await fx.cleanup();
  }
});

test('workspace.apply edits, runs real verification, and reports verified with evidence outside the checkout', async () => {
  const fx = await fixture('apply-ok');
  try {
    const tools = createEngineToolHandlers();
    const result = await tools['workspace.apply'](
      {
        operations: [{ type: 'write', path: 'value.txt', content: 'fixed' }],
        verification: [
          { command: 'node', args: ['-e', "if (require('node:fs').readFileSync('value.txt','utf8')!=='fixed') process.exit(3)"] },
        ],
        maxAttempts: 2,
      },
      { engine: fx.engine },
    );

    assert.equal(result.ok, true);
    assert.equal(result.output.state, 'verified');
    assert.equal(await readFile(path.join(fx.root, 'value.txt'), 'utf8'), 'fixed');
    const evidence = JSON.parse(await readFile(path.join(fx.evidence, 'result.json'), 'utf8'));
    assert.equal(evidence.state, 'verified');
  } finally {
    await fx.cleanup();
  }
});

test('workspace.apply self-heals via the LLM replan and rolls back on unrecoverable failure', async () => {
  const fx = await fixture('apply-replan');
  try {
    const tools = createEngineToolHandlers();
    let replans = 0;
    const llm = {
      async complete() {
        replans += 1;
        return {
          text: JSON.stringify({
            operations: [{ type: 'patch', path: 'value.txt', expected: 'initial', replacement: 'fixed' }],
            verification: [
              { command: 'node', args: ['-e', "if (require('node:fs').readFileSync('value.txt','utf8')!=='fixed') process.exit(3)"] },
            ],
          }),
        };
      },
    };

    await writeFile(path.join(fx.root, 'value.txt'), 'initial', 'utf8');
    const healed = await tools['workspace.apply'](
      {
        operations: [{ type: 'write', path: 'value.txt', content: 'wrong' }],
        verification: [
          { command: 'node', args: ['-e', "if (require('node:fs').readFileSync('value.txt','utf8')!=='fixed') process.exit(3)"] },
        ],
        maxAttempts: 2,
      },
      { engine: fx.engine, llm },
    );
    assert.equal(replans, 1);
    assert.equal(healed.output.state, 'verified');
    assert.equal(await readFile(path.join(fx.root, 'value.txt'), 'utf8'), 'fixed');

    // No replan available -> the engine rolls back only agent-touched files.
    await writeFile(path.join(fx.root, 'value.txt'), 'original', 'utf8');
    const failed = await tools['workspace.apply'](
      {
        operations: [{ type: 'write', path: 'value.txt', content: 'broken' }],
        verification: [{ command: 'node', args: ['-e', 'process.exit(9)'] }],
        maxAttempts: 1,
      },
      { engine: fx.engine },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.output.state, 'failed_rolled_back');
    assert.equal(await readFile(path.join(fx.root, 'value.txt'), 'utf8'), 'original');
  } finally {
    await fx.cleanup();
  }
});

test('workspace.apply refuses git verification commands (no push/merge/master from a tool)', async () => {
  const fx = await fixture('apply-git');
  try {
    const tools = createEngineToolHandlers();
    await assert.rejects(
      () =>
        tools['workspace.apply'](
          {
            operations: [{ type: 'write', path: 'a.txt', content: 'x' }],
            verification: [{ command: 'git', args: ['push'] }],
          },
          { engine: fx.engine },
        ),
      /APPLY_VERIFICATION_COMMAND_NOT_ALLOWED:git/,
    );
  } finally {
    await fx.cleanup();
  }
});

test('engine-only tools fail closed without an engine', async () => {
  const tools = createEngineToolHandlers();
  await assert.rejects(() => tools['files.patch']({ path: 'x', expected: 'a', replacement: 'b' }, {}), /ENGINE_REQUIRED/);
  await assert.rejects(() => tools['terminal.run']({ command: 'node', args: ['-e', '0'] }, {}), /ENGINE_REQUIRED/);
  await assert.rejects(
    () =>
      tools['workspace.apply'](
        { operations: [{ type: 'write', path: 'x', content: 'y' }], verification: [{ command: 'node', args: ['-e', '0'] }] },
        {},
      ),
    /ENGINE_REQUIRED/,
  );
});

test('RealWorkspace.list is permission-gated, bounded, and never follows symlinks', async () => {
  const fx = await fixture('list');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'semo0o-list-outside-'));
  try {
    await writeFile(path.join(fx.root, 'a.txt'), 'a');
    await writeFile(path.join(fx.root, 'b.txt'), 'b');
    await mkdir(path.join(fx.root, '.git'), { recursive: true });
    await writeFile(path.join(fx.root, '.git', 'config'), 'x');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(fx.root, 'link.txt'));

    const listing = await fx.engine.files.list({ scope: '.', maxFiles: 100 });
    assert.ok(listing.files.some((file) => file.path === 'a.txt'));
    assert.ok(!listing.files.some((file) => file.path.includes('.git')));
    assert.ok(!listing.files.some((file) => file.path === 'link.txt'));

    const bounded = await fx.engine.files.list({ scope: '.', maxFiles: 1 });
    assert.equal(bounded.files.length, 1);
    assert.equal(bounded.truncated, true);

    const denied = await createExecutionEngine({
      workspacePath: fx.root,
      evidenceDirectory: path.join(fx.root, '.denied-evidence'),
      grants: [],
    });
    await assert.rejects(() => denied.files.list({ scope: '.' }), /PERMISSION_DENIED|Permission denied/i);
  } finally {
    await fx.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('operation and verification normalizers reject malformed and disallowed input', () => {
  assert.throws(() => normalizeOperations([]), /APPLY_OPERATIONS_REQUIRED/);
  assert.throws(() => normalizeOperations([{ type: 'exec', path: 'x' }]), /APPLY_OPERATION_TYPE_INVALID/);
  assert.throws(() => normalizeOperations([{ type: 'write', path: 'x' }]), /APPLY_OPERATION_CONTENT_INVALID/);
  assert.throws(() => normalizeVerification([]), /APPLY_VERIFICATION_REQUIRED/);
  assert.throws(() => normalizeVerification([{ command: 'git', args: ['push'] }]), /APPLY_VERIFICATION_COMMAND_NOT_ALLOWED/);
  assert.deepEqual(normalizeVerification([{ command: 'npm', args: ['test'] }]), [{ command: 'npm', args: ['test'] }]);
});
