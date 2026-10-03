import assert from 'node:assert/strict';
import test from 'node:test';
import { clearCodeRunAdapter, configureCodeRunAdapter, registerCodeRunTool, unregisterCodeRunTool } from '../src/services/agent-engine/code-run';
import { runTool } from '../src/services/agent-engine/tools';

test('code.run fails explicitly when no server sandbox is configured', async () => {
  registerCodeRunTool();
  clearCodeRunAdapter();
  try {
    const result = await runTool('code.run', { language: 'javascript', source: 'console.log(1)' });
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /CODE_RUNNER_NOT_CONFIGURED/);
  } finally {
    unregisterCodeRunTool();
  }
});

test('code.run sends validated source to the configured real-runner boundary and returns evidence', async () => {
  const requests: unknown[] = [];
  registerCodeRunTool();
  configureCodeRunAdapter(async (request) => {
    requests.push(request);
    return {
      ok: true,
      language: request.language,
      stdout: '42\n',
      stderr: '',
      exitCode: 0,
      durationMs: 4,
      isolated: true,
      network: 'none',
      files: ['package.json'],
      evidenceDirectory: '/tmp/evidence/run-1',
    };
  });
  try {
    const result = await runTool('code.run', {
      language: 'javascript',
      source: 'console.log(42)',
      timeoutMs: 5000,
      maxOutputBytes: 1000,
    });
    assert.equal(result.ok, true);
    assert.equal((result.output as { exitCode: number }).exitCode, 0);
    assert.equal((result.output as { isolated: boolean }).isolated, true);
    assert.equal(requests.length, 1);
    assert.equal((requests[0] as { source: string }).source, 'console.log(42)');
  } finally {
    clearCodeRunAdapter();
    unregisterCodeRunTool();
  }
});
