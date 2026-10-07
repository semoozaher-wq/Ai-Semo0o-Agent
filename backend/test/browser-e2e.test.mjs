import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { browserBinaryAvailable } from '../browser/launcher.mjs';

/**
 * End-to-end guard for the real browser E2E (scripts/browser-e2e.mjs).
 *
 * The script launches a REAL Chromium and drives it over CDP. This test runs it
 * as a subprocess and asserts the real evidence (verification results, a real
 * PNG screenshot, the product `runBrowserTask` path and the `browser.run` tool).
 * It skips honestly when no browser binary is configured, so CI without a
 * browser never reports a fake pass.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'browser-e2e.mjs');
const PNG_MAGIC = '89504e470d0a1a0a';

function runBrowserE2e(outFile, screenshotFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', SCRIPT, '--out', outFile, '--screenshot', screenshotFile], {
      cwd: REPO_ROOT,
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('BROWSER_E2E_TIMEOUT')); }, 120_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

test('browser e2e: a real browser is launched and driven over CDP', { skip: browserBinaryAvailable() ? false : 'no browser binary configured (set CHROME_BIN/BROWSER_BIN)' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'browser-e2e-test-'));
  const outFile = path.join(dir, 'report.json');
  const screenshotFile = path.join(dir, 'screenshot.png');
  try {
    const { code, stdout, stderr } = await runBrowserE2e(outFile, screenshotFile);
    assert.equal(code, 0, `browser e2e exited ${code}\n${stdout}\n${stderr}`);
    assert.match(stdout, /RESULT: browser-e2e passed=true/);

    const report = JSON.parse(await readFile(outFile, 'utf8'));
    assert.equal(report.passed, true);

    // Scenario 1: BrowserAgent over CDP — every check must really pass.
    const agent = report.scenarios.find((scenario) => scenario.name === 'browser-agent-cdp');
    assert.ok(agent, 'browser-agent-cdp scenario must run');
    assert.equal(agent.ok, true);
    assert.equal(agent.verification.ok, true);
    assert.ok(agent.verification.results.length >= 4);
    assert.ok(agent.verification.results.every((result) => result.ok === true), JSON.stringify(agent.verification.results));
    assert.ok(agent.evidenceEvents > 0, 'CDP events must be captured as evidence');
    assert.ok(agent.screenshotBytes > 0);

    // Scenario 2: the product browser runner.
    const task = report.scenarios.find((scenario) => scenario.name === 'run-browser-task');
    assert.ok(task, 'run-browser-task scenario must run');
    assert.equal(task.ok, true);
    assert.equal(task.verification.ok, true);

    // Scenario 3: the browser.run tool (network-dependent — pass or skip, never fake).
    const tool = report.scenarios.find((scenario) => scenario.name === 'browser-run-tool');
    assert.ok(tool, 'browser-run-tool scenario must be reported');
    assert.ok(tool.skipped === true || tool.ok === true, JSON.stringify(tool));

    // The screenshot is a real PNG, not an empty buffer.
    const png = await readFile(screenshotFile);
    assert.equal(png.subarray(0, 8).toString('hex'), PNG_MAGIC);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
