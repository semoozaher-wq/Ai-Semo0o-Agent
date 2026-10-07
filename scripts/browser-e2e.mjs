#!/usr/bin/env node
/**
 * scripts/browser-e2e.mjs — Real Browser End-to-End (CDP).
 *
 * Launches a REAL local Chromium and drives it over the Chrome DevTools
 * Protocol against a REAL page, exercising the exact browser execution path the
 * product uses (`backend/browser/*` -> `phase2-core/browser-agent.mjs`):
 *
 *   1. browser-agent-cdp  — BrowserAgent over CDP: navigate -> click -> type ->
 *                           scroll -> verify -> screenshot -> evidence.
 *   2. run-browser-task   — `runBrowserTask` (the product's browser runner) with
 *                           real actions + verification checks.
 *   3. browser-run-tool   — the real `browser.run` tool through the live tool
 *                           registry (SSRF guard -> resolveCdpEndpoint -> local
 *                           launch -> runBrowserTask) against a public page.
 *
 * Nothing is mocked: a real browser process is spawned, real DOM interactions
 * run, and the verification + screenshot are captured as evidence. The script
 * exits non-zero when any executed scenario fails.
 *
 * Environment:
 *   CHROME_BIN / BROWSER_BIN  — path to a Chromium/Chrome binary (required when
 *                               no browser is on PATH).
 *   BROWSER_NO_SANDBOX=true   — add --no-sandbox (required when running as root,
 *                               e.g. inside a container).
 *   BROWSER_E2E_PUBLIC_URL    — public URL for scenario 3 (default example.com).
 *
 * Usage:
 *   node scripts/browser-e2e.mjs [--out report.json] [--public-url https://example.com] [--keep]
 */
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchLocalChromium, browserBinaryAvailable } from '../backend/browser/launcher.mjs';
import { runBrowserTask } from '../backend/browser/runner.mjs';
import { BrowserAgent } from '../phase2-core/browser-agent.mjs';
import { createLiveToolRegistry } from '../backend/tools/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const keep = process.argv.includes('--keep');
const outFile = arg('--out', path.join(REPO_ROOT, 'browser-e2e.report.json'));
const screenshotFile = arg('--screenshot', path.join(REPO_ROOT, 'browser-e2e.screenshot.png'));
const publicUrl = arg('--public-url', process.env.BROWSER_E2E_PUBLIC_URL || 'https://example.com');

// A self-contained page with a counter, a form and a tall body so the E2E can
// prove real navigation, clicking, typing, scrolling and verification.
const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Browser E2E</title></head>
<body>
  <h1 id="title">Browser E2E</h1>
  <div>
    <span id="count">0</span>
    <button id="increment" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">increment</button>
  </div>
  <div>
    <input id="name" />
    <button id="greet" onclick="document.getElementById('greeting').textContent = 'Hello, ' + document.getElementById('name').value">greet</button>
    <div id="greeting"></div>
  </div>
  <div style="height: 2000px"></div>
  <div id="bottom">bottom</div>
</body>
</html>`;

const CHECKS = [
  { id: 'title', description: 'h1 title rendered', expression: 'document.querySelector("#title")?.textContent === "Browser E2E"' },
  { id: 'counter', description: 'counter incremented three times', expression: 'document.querySelector("#count")?.textContent === "3"' },
  { id: 'greeting', description: 'typed value greeted', expression: 'document.querySelector("#greeting")?.textContent === "Hello, Semo"' },
  { id: 'scrolled', description: 'page scrolled', expression: 'window.scrollY > 0' },
];

const ACTIONS = [
  { type: 'click', selector: '#increment' },
  { type: 'click', selector: '#increment' },
  { type: 'click', selector: '#increment' },
  { type: 'type', selector: '#name', text: 'Semo' },
  { type: 'click', selector: '#greet' },
  { type: 'scroll', x: 0, y: 400 },
];

async function startPageServer() {
  const server = createServer((request, response) => {
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' });
    response.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` }; // security-scan:allow private-url-literal (local loopback bind)
}

async function reachable(url) {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000), redirect: 'follow' });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  if (!browserBinaryAvailable()) throw new Error('BROWSER_BINARY_NOT_FOUND: set CHROME_BIN/BROWSER_BIN to a Chromium/Chrome binary');
  const { server, url } = await startPageServer();
  const report = { startedAt: new Date().toISOString(), pageUrl: url, scenarios: [] };
  let exitCode = 0;
  let launcher;
  try {
    launcher = await launchLocalChromium({ timeoutMs: 25_000 });
    report.browser = { binary: launcher.binary, pageWebSocket: launcher.webSocketUrl, browserWebSocket: launcher.browserWebSocketUrl };

    // ---- Scenario 1: BrowserAgent over CDP ----
    const agent = new BrowserAgent(launcher.webSocketUrl, { timeoutMs: 20_000 });
    await agent.connect();
    await agent.navigate(url);
    // Interact first (click x3, type, greet) so the content screenshot shows the
    // real DOM state, then scroll last to prove scrolling works.
    for (const action of ACTIONS.filter((item) => item.type !== 'scroll')) {
      if (action.type === 'click') await agent.click(action.selector);
      else if (action.type === 'type') await agent.type(action.selector, action.text);
    }
    const contentScreenshot = await agent.screenshot();
    await agent.scroll(0, 400);
    const verification = await agent.verify(CHECKS);
    const evidence = agent.evidence();
    const scrolledScreenshot = await agent.screenshot();
    await agent.close();
    report.scenarios.push({
      name: 'browser-agent-cdp',
      ok: verification.ok === true && contentScreenshot.length > 0 && scrolledScreenshot.length > 0 && evidence.events.length > 0,
      verification,
      evidenceEvents: evidence.events.length,
      screenshotBytes: contentScreenshot.length,
      scrolledScreenshotBytes: scrolledScreenshot.length,
    });
    await writeFile(screenshotFile, contentScreenshot);

    // ---- Scenario 2: runBrowserTask (the product's browser runner) ----
    const taskResult = await runBrowserTask({ webSocketUrl: launcher.webSocketUrl, url, actions: ACTIONS, checks: CHECKS });
    report.scenarios.push({
      name: 'run-browser-task',
      ok: taskResult.ok === true && taskResult.screenshot.length > 0,
      verification: taskResult.verification,
      screenshotBytes: taskResult.screenshot.length,
    });

    // ---- Scenario 3: the real browser.run tool through the live registry ----
    process.env.BROWSER_LAUNCH_LOCAL = 'true';
    const tools = createLiveToolRegistry({ getWorkspaceRoot: () => os.tmpdir() });
    const browserToolLive = tools.status().live.includes('browser.run');
    if (await reachable(publicUrl)) {
      const result = await tools.run('browser.run', {
        url: publicUrl,
        checks: [
          { id: 'title', description: 'document has a title', expression: 'document.title.length > 0' },
          { id: 'body', description: 'document has a body', expression: '!!document.body' },
        ],
      }, {});
      report.scenarios.push({
        name: 'browser-run-tool',
        ok: result.ok === true && result.output?.verification?.ok === true && (result.output?.screenshot?.length ?? 0) > 0,
        url: publicUrl,
        browserToolLive,
        verification: result.output?.verification,
        screenshotBytes: result.output?.screenshot?.length ?? 0,
      });
    } else {
      report.scenarios.push({ name: 'browser-run-tool', skipped: true, reason: 'public_url_unreachable', url: publicUrl, browserToolLive });
    }

    report.finishedAt = new Date().toISOString();
    const executed = report.scenarios.filter((scenario) => !scenario.skipped);
    report.passed = executed.length >= 2 && executed.every((scenario) => scenario.ok === true);
    report.summary = {
      total: report.scenarios.length,
      executed: executed.length,
      passed: executed.filter((scenario) => scenario.ok === true).length,
      failed: executed.filter((scenario) => scenario.ok !== true).map((scenario) => scenario.name),
      skipped: report.scenarios.filter((scenario) => scenario.skipped).map((scenario) => scenario.name),
    };

    await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`\n${JSON.stringify(report.summary, null, 2)}\n`);
    process.stdout.write(`Screenshot: ${screenshotFile}\nReport written to ${outFile}\n`);
    process.stdout.write(`RESULT: browser-e2e passed=${report.passed} scenarios=${executed.filter((scenario) => scenario.ok === true).length}/${executed.length}\n`);
    exitCode = report.passed ? 0 : 1;
  } finally {
    if (launcher) { try { await launcher.close(); } catch { /* cleanup must not mask result */ } }
    await new Promise((resolve) => server.close(resolve));
    if (keep) process.stdout.write(`Kept report at ${outFile}\n`);
  }
  process.exit(exitCode);
}

main().catch((error) => {
  process.stderr.write(`browser-e2e failed: ${error?.stack || error}\n`);
  process.exit(1);
});
