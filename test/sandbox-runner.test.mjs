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
  validateCodeRunRequest,
} from '../execution-core/sandbox.mjs';

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
