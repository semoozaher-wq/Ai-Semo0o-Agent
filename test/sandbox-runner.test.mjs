import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DockerSandboxRunner,
  SandboxError,
  buildDockerInvocation,
  runJavaScriptInVm,
  validateCodeRunRequest,
} from '../execution-core/sandbox.mjs';
import { createDockerCodeRunAdapter } from '../execution-core/code-run-tool.mjs';

function fakeSpawn({ exitCode = 0, stdout = 'ok\n', stderr = '' } = {}) {
  return (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode, null);
    });
    return child;
  };
}

test('VM runner captures console output and awaits promises', async () => {
  const result = await runJavaScriptInVm({
    source: "console.log('hello', 2); await new Promise(resolve => setTimeout(() => resolve(), 5)); return 42;",
  });
  assert.equal(result.ok, true);
  assert.equal(result.result, 42);
  assert.equal(result.logs[0].message, 'hello 2');
});

test('VM runner returns structured errors and enforces timeout', async () => {
  const error = await runJavaScriptInVm({ source: "throw new Error('bad input')" });
  assert.equal(error.ok, false);
  assert.match(error.error, /bad input/);
  const timeout = await runJavaScriptInVm({ source: 'await new Promise(() => {})', timeoutMs: 20 });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.errorCode, 'VM_TIMEOUT');
});

test('code-run request rejects unsupported languages and unsafe files', () => {
  assert.throws(() => validateCodeRunRequest({ language: 'ruby', source: 'puts 1' }), (error) => error instanceof SandboxError && error.code === 'UNSUPPORTED_LANGUAGE');
  assert.throws(() => validateCodeRunRequest({ language: 'javascript', source: '1', files: [{ path: '../escape.js', content: 'x' }] }), /normalized relative paths/i);
  assert.throws(() => validateCodeRunRequest({ language: 'javascript', source: '1', network: 'internet' }), /network=none/i);
});

test('Docker invocation enforces no network, read-only root, dropped capabilities, and limits', () => {
  const built = buildDockerInvocation({ language: 'javascript', source: 'console.log(1)', timeoutMs: 1000 }, '/tmp/workspace');
  assert.ok(built.args.includes('--network=none'));
  assert.ok(built.args.includes('--read-only'));
  assert.ok(built.args.includes('--cap-drop=ALL'));
  assert.ok(built.args.includes('--security-opt=no-new-privileges'));
  assert.ok(built.args.includes('--memory=512m'));
  assert.ok(built.args.includes('--pids-limit=128'));
  assert.ok(built.args.includes('node'));
  assert.ok(built.args.includes('/workspace/main.js'));
});

test('Docker runner returns bounded evidence and removes the temporary workspace', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'semo0o-sandbox-test-'));
  const evidence = [];
  try {
    const runner = new DockerSandboxRunner({
      tempRoot,
      spawnImpl: fakeSpawn({ stdout: 'hello\n' }),
      onEvidence: async (record) => evidence.push(record),
    });
    const result = await runner.run({ language: 'javascript', source: 'console.log("hello")' });
    assert.equal(result.ok, true);
    assert.equal(result.isolated, true);
    assert.equal(result.network, 'none');
    assert.equal(result.stdout, 'hello\n');
    assert.equal(evidence.length, 1);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Docker runner marks non-zero execution as failed and caps output', async () => {
  const runner = new DockerSandboxRunner({
    spawnImpl: fakeSpawn({ exitCode: 2, stdout: '123456789' }),
  });
  const result = await runner.run({ language: 'python', source: 'raise SystemExit(2)', maxOutputBytes: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.outputTruncated, true);
  assert.equal(result.stdout, '1234');
});

test('Docker code-run adapter forwards workspace files and preserves sandbox evidence', async () => {
  const seen = [];
  const adapter = createDockerCodeRunAdapter({
    getWorkspaceFiles: async () => [{ path: 'package.json', content: '{}' }],
    runner: {
      run: async (request) => {
        seen.push(request);
        return { ok: true, language: request.language, stdout: 'ok\n', stderr: '', exitCode: 0, durationMs: 2, isolated: true, network: 'none' };
      },
    },
  });
  const result = await adapter({ language: 'javascript', source: 'console.log("ok")' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.files, ['package.json']);
  assert.equal(result.network, 'none');
  assert.equal(seen[0].files[0].path, 'package.json');
});
