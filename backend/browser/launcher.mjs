import { spawn } from 'node:child_process';
import { chmodSync, chownSync, copyFileSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';

// Candidate browser binaries, in priority order. Operators can override with
// CHROME_BIN / CHROMIUM_BIN / BROWSER_BIN (the CI workflow exports CHROMIUM_BIN,
// see .github/workflows/quality.yml). We only ever launch a real, locally
// installed browser; when none is found the launcher fails closed so browser.run
// stays honestly reported as unwired instead of pretending to work.
const CANDIDATE_BINARIES = [
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

// Resolved on every call (not cached at import) so env overrides take effect
// even when they are set after this module is loaded.
function candidateBinaries() {
  return [process.env.CHROME_BIN, process.env.CHROMIUM_BIN, process.env.BROWSER_BIN, ...CANDIDATE_BINARIES];
}

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
  for (const candidate of candidateBinaries()) {
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

/** Absolute path to the browser binary that would be launched, or null. */
export function resolveBrowserBinary() {
  return firstExistingBinary();
}

// Chromium stderr signatures that mean "the sandbox is unusable here" (as
// opposed to a generic crash): the namespace sandbox is blocked ("No usable
// sandbox!" / zygote host), or the SUID helper exists but is not setuid
// ("setuid_sandbox_host ... not configured correctly"). Used to recover via the
// SUID sandbox instead of ever disabling the sandbox.
export const SANDBOX_ERROR_PATTERN = /No usable sandbox|zygote_host_impl_linux|setuid_sandbox_host|SUID sandbox helper/i;

// Chromium's Linux sandbox has two mechanisms:
//   1. the NAMESPACE sandbox, which needs unprivileged user namespaces, and
//   2. the SUID sandbox, a setuid-root helper (`chrome-sandbox`) next to the
//      browser binary.
// Ubuntu 23.10+/24.04 (and many containers/CI runners) restrict unprivileged
// user namespaces via AppArmor, so mechanism 1 aborts with
// "FATAL:...zygote_host_impl_linux.cc] No usable sandbox!". The correct fix is
// NOT to disable the sandbox (`--no-sandbox` weakens security) but to use the
// SUID sandbox, which keeps the sandbox ON. Chromium only honours the helper
// when it is owned by root and setuid (mode 4755).
const SANDBOX_HELPER_NAMES = ['chrome-sandbox', 'chrome_sandbox'];

// Directories that may hold the sandbox helper. Chromium resolves symlinks to
// locate its own directory, so a symlinked launcher (e.g.
// /usr/bin/chromium -> /usr/lib/chromium/chromium, or
// /usr/local/bin/google-chrome -> /opt/chrome/chrome) expects the helper next to
// the REAL binary. We therefore consider the realpath directory first, then the
// invoked path's directory as a fallback.
function binaryDirs(binary) {
  const dirs = [];
  const push = (dir) => { if (dir && !dirs.includes(dir)) dirs.push(dir); };
  try { push(path.dirname(realpathSync(binary))); } catch { /* binary missing */ }
  push(path.dirname(binary));
  return dirs;
}

function sandboxHelperCandidates(binary) {
  const helpers = [];
  for (const dir of binaryDirs(binary)) {
    for (const name of SANDBOX_HELPER_NAMES) helpers.push(path.join(dir, name));
  }
  return helpers;
}

/** True when a root-owned, setuid (4755) sandbox helper sits next to the binary. */
export function isSuidSandboxReady(binary) {
  for (const helper of sandboxHelperCandidates(binary)) {
    try {
      const stats = lstatSync(helper);
      if (stats.isFile() && (stats.mode & 0o4000) !== 0 && stats.uid === 0) return true;
    } catch { /* helper absent */ }
  }
  return false;
}

/**
 * Best-effort enable Chromium's SUID sandbox so the browser can start WITHOUT
 * disabling its sandbox: make the root-owned helper next to the binary setuid
 * (mode 4755). Chromium looks for `chrome-sandbox`; some builds only ship
 * `chrome_sandbox`, so we materialise the expected name from it. Only succeeds
 * when the caller has the privilege to chown/chmod (root, or the setup script
 * run via sudo). Returns true when a usable helper is in place afterwards.
 */
export function enableSuidSandbox(binary) {
  if (isSuidSandboxReady(binary)) return true;
  for (const dir of binaryDirs(binary)) {
    const hyphen = path.join(dir, 'chrome-sandbox');
    const underscore = path.join(dir, 'chrome_sandbox');
    try {
      // Some builds ship the helper as `chrome_sandbox`; Chromium expects
      // `chrome-sandbox`. Materialise it (never following a symlink source).
      if (!existsSync(hyphen) && existsSync(underscore) && lstatSync(underscore).isFile()) {
        copyFileSync(underscore, hyphen);
      }
    } catch { /* not writable */ }
    for (const helper of [hyphen, underscore]) {
      try {
        const stats = lstatSync(helper);
        if (!stats.isFile()) continue; // never chmod a symlink
        chownSync(helper, 0, 0);
        chmodSync(helper, 0o4755);
      } catch { /* not privileged enough / absent */ }
    }
  }
  return isSuidSandboxReady(binary);
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
// A single launch attempt. `noSandbox` decides whether Chromium is told to skip
// its sandbox; the retry policy lives in launchLocalChromium below.
async function launchChromiumOnce({ binary, port, timeoutMs, extraArgs, headless, noSandbox }) {
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
    ...(noSandbox ? ['--no-sandbox'] : []),
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let stderr = '';
  const portFromStderr = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BROWSER_LAUNCH_TIMEOUT')), timeoutMs);
    const onData = (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    };
    child.stderr.on('data', onData);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    // `close` (not `exit`) fires after stdio has been flushed, so the full
    // Chromium stderr -- including the sandbox FATAL line -- is captured.
    child.once('close', (code) => {
      clearTimeout(timer);
      const detail = stderr.slice(0, 3000);
      // Distinguish "the browser cannot sandbox in this environment" from a
      // generic early exit, so the caller can recover WITHOUT weakening security.
      // Two signatures: the namespace sandbox is blocked ("No usable sandbox!"
      // from the zygote host), or the SUID helper is present but not setuid
      // ("setuid_sandbox_host ... not configured correctly").
      if (SANDBOX_ERROR_PATTERN.test(stderr)) {
        reject(new Error(`BROWSER_SANDBOX_UNAVAILABLE:${code}: ${detail}`));
      } else {
        reject(new Error(`BROWSER_EXITED_EARLY:${code}: ${detail}`));
      }
    });
  });

  const cleanup = async () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { await rm(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    const actualPort = await portFromStderr;
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
 * Launch a local headless Chromium and resolve its CDP websocket URL.
 * Returns a handle with `webSocketUrl` (a PAGE target the agent can drive),
 * `browserWebSocketUrl` (the browser-level endpoint), `close()` and the spawned
 * pid. The caller is responsible for calling close() to release the process +
 * temp dir.
 *
 * Sandbox handling: Chromium's Linux sandbox needs unprivileged user namespaces.
 * On Ubuntu 23.10+/24.04 (and other distros) AppArmor restricts them, so Chromium
 * aborts at startup with `FATAL:...zygote_host_impl_linux.cc] No usable sandbox!`
 * for NON-root users too -- which is why the root-only BROWSER_NO_SANDBOX opt-in
 * is not sufficient (CI runners and containers are non-root). We never silently
 * disable the sandbox: instead, when the namespace sandbox is unavailable, we
 * enable Chromium's SUID sandbox (a real sandbox; best-effort, needs privilege)
 * and retry once. An explicit BROWSER_NO_SANDBOX=true remains an opt-in escape
 * hatch for operators who accept the reduced isolation.
 */
export async function launchLocalChromium({ port = 0, timeoutMs = 20000, extraArgs = [], headless = true } = {}) {
  const binary = firstExistingBinary();
  if (!binary) throw new Error('BROWSER_BINARY_NOT_FOUND');
  const noSandboxExplicit = process.env.BROWSER_NO_SANDBOX === 'true';
  try {
    return await launchChromiumOnce({ binary, port, timeoutMs, extraArgs, headless, noSandbox: noSandboxExplicit });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (noSandboxExplicit || !message.includes('BROWSER_SANDBOX_UNAVAILABLE')) throw error;
    // The namespace sandbox is unavailable (AppArmor-restricted user namespaces).
    // Keep the sandbox ON: switch to the SUID sandbox and retry once. If we lack
    // the privilege to set it up, surface the clear, actionable error instead of
    // silently disabling the sandbox.
    if (enableSuidSandbox(binary)) {
      return await launchChromiumOnce({ binary, port, timeoutMs, extraArgs, headless, noSandbox: false });
    }
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
