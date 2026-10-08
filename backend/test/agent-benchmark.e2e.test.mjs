import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * End-to-end guard for the real agent benchmark (scripts/agent-benchmark.mjs).
 *
 * The benchmark drives the REAL stack (HTTP API -> RunQueue -> agent runtime ->
 * tools -> evidence) across every execution strategy: the single-agent loop, the
 * multi-agent TaskGraph, and the long-running continuation. This test runs the
 * benchmark as a subprocess and asserts it passes with real evidence, so the
 * benchmark can never silently rot into a fake pass.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'agent-benchmark.mjs');

function runBenchmark(outFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', SCRIPT, '--out', outFile], {
      cwd: REPO_ROOT,
      env: { ...process.env, AGENT_MAX_CONTINUATIONS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('BENCHMARK_TIMEOUT')); }, 120_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('agent benchmark: the end-to-end benchmark passes every real scenario', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-bench-test-'));
  const outFile = path.join(dir, 'report.json');
  try {
    const { code, stdout, stderr } = await runBenchmark(outFile);
    assert.equal(code, 0, `benchmark exited ${code}\n${stdout}\n${stderr}`);
    assert.match(stdout, /RESULT: agent-loop=100% multi-agent=100% long-running=100% code-intelligence=100% self-healing=100% integrations=100% passed=true/);

    const report = JSON.parse(await readFile(outFile, 'utf8'));
    assert.equal(report.passed, true);
    assert.equal(report.agentLoop.summary.passRate, 100);
    assert.equal(report.multiAgent.summary.passRate, 100);
    assert.equal(report.longRunning.summary.passRate, 100);
    assert.equal(report.codeIntelligence.summary.passRate, 100);
    assert.equal(report.selfHealing.summary.passRate, 100);
    assert.equal(report.integrations.summary.passRate, 100);

    // The multi-agent scenario really ran a TaskGraph of specialists with evidence.
    const multiAgent = report.steps.find((item) => item.name === 'multi-agent finished');
    assert.equal(multiAgent.multiAgent, true);
    assert.ok(multiAgent.graphNodes >= 5, `expected >=5 graph nodes, got ${multiAgent.graphNodes}`);
    assert.ok(multiAgent.nodesCompleted >= 5, `expected >=5 completed nodes, got ${multiAgent.nodesCompleted}`);
    assert.ok(multiAgent.evidenceCount >= 3, `expected >=3 evidence rows, got ${multiAgent.evidenceCount}`);

    // The long-running scenario really checkpointed and scheduled a bounded continuation.
    const longRunning = report.steps.find((item) => item.name === 'long-running finished');
    assert.equal(longRunning.status, 'completed_with_warnings');
    assert.equal(longRunning.continuation.scheduled, true);
    assert.ok(longRunning.continuation.runId, 'continuation run id must be recorded');
    assert.equal(longRunning.continuationContinuation.scheduled, false);
    assert.equal(longRunning.continuationContinuation.reason, 'continuation_limit_reached');

    // The self-healing scenario really diagnosed and repaired a failing call.
    const selfHealing = report.steps.find((item) => item.name === 'self-healing finished');
    assert.equal(selfHealing.status, 'completed');
    assert.ok(selfHealing.repairEvents >= 1, `expected a repair event, got ${selfHealing.repairEvents}`);
    assert.equal(selfHealing.failedRead, true, 'the first read must have failed');
    assert.equal(selfHealing.repairedRead, true, 'the repaired read must have succeeded');
    assert.deepEqual(selfHealing.readOutcomes, [false, true]);
    assert.ok(selfHealing.evidenceCount >= 2, `expected >=2 evidence rows, got ${selfHealing.evidenceCount}`);

    // The integrations scenario really delivered an email over a live connector.
    const integrations = report.steps.find((item) => item.name === 'integrations finished');
    assert.equal(integrations.status, 'completed');
    assert.ok(integrations.deliveredCount >= 1, `expected a real delivery, got ${integrations.deliveredCount}`);
    assert.ok(integrations.deliveredTo.includes('ops@example.com'), 'the connector must receive the real recipient');
    assert.equal(integrations.emailToolOk, true, 'the email.send tool call must report ok');
    assert.equal(integrations.connectorLive, true, 'the registry must report email.send live');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
