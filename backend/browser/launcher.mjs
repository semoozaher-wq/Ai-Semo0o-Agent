import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';

// Candidate browser binaries, in priority order. Operators can override with
// CHROME_BIN / CHROMIUM_BIN / BROWSER_BIN (the CI workflow exports CHROMIUM_BIN,
// see .github/workflows/quality.yml). We only ever launch a real, locally
// installed browser; when none is found the launcher fails closed so browser.run
// stays honestly reported as unwired instead of pretending to work.
const CANDIDATES = [
  process.env.CHROME_BIN,
  process.env.CHROMIUM_BIN,
  process.env.BROWSER_BIN,
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function onPath(name) {
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function firstExistingBinary() {
  for (const candidate of CANDIDATES) {
    if (!candidate) continue;
    if (candidate.includes(path.sep)) {
      if (existsSync(candidate)) return candidate;
    } else {
      // A bare name must actually resolve on PATH; otherwise the launcher would
      // claim a browser is available and then fail to spawn it.
      const resolved = onPath(candidate);
      if (resolved) return resolved;
    }
  }
  return null;
}

export function browserBinaryAvailable() {
  return Boolean(firstExistingBinary());
}

function waitForPort(port, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = createConnection({ host: '127.0.0.1', port }); // security-scan:allow private-url-literal
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error('BROWSER_LAUNCH_TIMEOUT'));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function readDevtoolsUrl(port, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) }); // security-scan:allow private-url-literal
      if (response.ok) {
        const data = await response.json();
        if (data?.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
      }
    } catch { /* retry until timeout */ }
    if (Date.now() - start > timeoutMs) throw new Error('BROWSER_DEVTOOLS_URL_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

// `BrowserAgent` drives a PAGE target: `Runtime.*` / `Page.*` / `Network.*` are
// only routable on a page session, not on the browser-level endpoint returned by
// `/json/version`. Resolve the page target's own websocket so the agent can
// actually navigate and evaluate instead of failing with "method not found".
async function readPageTargetUrl(port, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }); // security-scan:allow private-url-literal
      if (response.ok) {
        const targets = await response.json();
        const page = Array.isArray(targets) ? targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) : null;
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch { /* retry until timeout */ }
    if (Date.now() - start > timeoutMs) throw new Error('BROWSER_PAGE_TARGET_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Launch a local headless Chromium and resolve its CDP websocket URL.
 * Returns a handle with `webSocketUrl` (a PAGE target the agent can drive),
 * `browserWebSocketUrl` (the browser-level endpoint), `close()` and the spawned
 * pid. The caller is responsible for calling close() to release the process +
 * temp dir.
 */
export async function launchLocalChromium({ port = 0, timeoutMs = 20000, extraArgs = [], headless = true } = {}) {
  const binary = firstExistingBinary();
  if (!binary) throw new Error('BROWSER_BINARY_NOT_FOUND');
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'semo0o-browser-'));
  const args = [
    '--remote-debugging-port=' + port,
    '--remote-debugging-address=127.0.0.1', // security-scan:allow private-url-literal
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    '--user-data-dir=' + userDataDir,
    // Opt-in only: root/container environments cannot use the Chromium sandbox,
    // so operators explicitly enable this instead of us weakening it by default.
    ...(process.env.BROWSER_NO_SANDBOX === 'true' ? ['--no-sandbox'] : []),
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let stderr = '';
  let actualPort = port;
  const portFromStderr = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BROWSER_LAUNCH_TIMEOUT')), timeoutMs);
    const onData = (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stderr.on('data', onData);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`BROWSER_EXITED_EARLY:${code}`)); });
  });

  const cleanup = async () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { await rm(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    actualPort = await portFromStderr;
    await waitForPort(actualPort, timeoutMs);
    const browserWebSocketUrl = await readDevtoolsUrl(actualPort, timeoutMs);
    const webSocketUrl = await readPageTargetUrl(actualPort, timeoutMs);
    return {
      webSocketUrl,
      browserWebSocketUrl,
      port: actualPort,
      pid: child.pid,
      binary,
      close: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Build a Chromium `--host-resolver-rules` value that PINS `host` to the exact
 * addresses the SSRF guard validated (`resolveSafeUrl(...).addresses`). Chrome's
 * host resolver honours these rules for every request (including the top-level
 * `Page.navigate`), so the browser can never re-resolve the name to a private
 * address between the guard check and the navigation — the DNS-rebinding /
 * TOCTOU fix. Unlike rewriting the URL to a bare IP, this keeps the hostname
 * intact, so HTTPS SNI, certificate validation, the Host header and redirects
 * all behave exactly as normal.
 */
export function hostResolverRule(host, addresses) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).map((address) => String(address ?? '').trim()).filter(Boolean);
  if (!host || !list.length) return null;
  return list.map((address) => `MAP ${host} ${address}`).join(', ');
}

/**
 * Resolve the CDP websocket URL for a run. Prefers an externally managed
 * BROWSER_CDP_URL; otherwise, when BROWSER_LAUNCH_LOCAL=true, launches a local
 * browser. Returns { webSocketUrl, launcher, pinned } where launcher is non-null
 * only for locally launched browsers and must be closed by the caller, and
 * `pinned` reports whether the validated address was pinned into the browser's
 * host resolver (`options.targetHost` + `options.pinnedAddresses`).
 */
export async function resolveCdpEndpoint(env = process.env, options = {}) {
  if (env.BROWSER_CDP_URL) return { webSocketUrl: env.BROWSER_CDP_URL, launcher: null, pinned: false };
  if (env.BROWSER_LAUNCH_LOCAL === 'true') {
    // Pin the validated address at launch: the browser resolves `targetHost` to
    // the address the guard checked, never a re-resolved (possibly private) one.
    const rule = options.targetHost ? hostResolverRule(options.targetHost, options.pinnedAddresses) : null;
    const launcher = await launchLocalChromium({
      timeoutMs: Number(env.BROWSER_LAUNCH_TIMEOUT_MS || options.timeoutMs || 20000),
      extraArgs: rule ? [`--host-resolver-rules=${rule}`] : [],
    });
    return { webSocketUrl: launcher.webSocketUrl, launcher, pinned: Boolean(rule) };
  }
  throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:browser.run');
}
