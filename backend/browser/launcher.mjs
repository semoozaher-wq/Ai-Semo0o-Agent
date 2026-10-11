import { spawn } from 'node:child_process';
import { chmodSync, chownSync, closeSync, copyFileSync, existsSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
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

// -----------------------------------------------------------------------------
// Playwright self-discovery (LAST-RESORT layer).
//
// `resolveBrowserBinary()` historically consulted only CHROME_BIN / CHROMIUM_BIN /
// BROWSER_BIN and a fixed PATH list. That means a deployment which installed the
// browser through Playwright (`npx playwright install chromium`) could still fail
// to find it unless the CI/deploy step explicitly exported CHROME_BIN. To make the
// backend self-sufficient, we scan Playwright's own browser cache as a final
// fallback. It is deliberately LAST: an explicit operator override always wins,
// and a missing cache simply returns null so the launcher keeps failing closed
// (never pretending a browser exists).
// -----------------------------------------------------------------------------

// Playwright's default cache root per platform (mirrors `playwright`'s own
// resolution). PLAYWRIGHT_BROWSERS_PATH overrides it.
export function playwrightCacheRoot(env = process.env) {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured) return configured;
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    return path.join(local, 'ms-playwright');
  }
  if (process.platform === 'darwin') return path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(homedir(), '.cache', 'ms-playwright');
}

// The executable path INSIDE a revisioned Playwright chromium build directory,
// per platform. Newer Playwright ships `chrome-linux64`; older ships
// `chrome-linux`. macOS ships `chrome-mac` / `chrome-mac-arm64`.
function playwrightRelativeBinaries() {
  if (process.platform === 'win32') return [path.join('chrome-win64', 'chrome.exe'), path.join('chrome-win', 'chrome.exe')];
  if (process.platform === 'darwin') return [
    path.join('chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    path.join('chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ];
  return [path.join('chrome-linux64', 'chrome'), path.join('chrome-linux', 'chrome')];
}

// Ordered Playwright chromium candidate paths: every `chromium-<revision>` (and
// `chromium_headless_shell-<revision>`) build directory, newest revision first,
// each expanded to the platform's executable path.
export function playwrightChromiumCandidates(env = process.env) {
  const root = playwrightCacheRoot(env);
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const builds = entries
    .filter((entry) => entry.isDirectory() && /^chromium(_headless_shell)?-\d+$/.test(entry.name))
    .map((entry) => ({ name: entry.name, revision: Number(entry.name.slice(entry.name.lastIndexOf('-') + 1)) }))
    .sort((a, b) => b.revision - a.revision);
  const candidates = [];
  for (const build of builds) {
    for (const relative of playwrightRelativeBinaries()) candidates.push(path.join(root, build.name, relative));
  }
  return candidates;
}

// First existing Playwright-managed Chromium, or null. The final fallback layer.
export function findPlaywrightChromium(env = process.env) {
  for (const candidate of playwrightChromiumCandidates(env)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Resolved on every call (not cached at import) so env overrides take effect
// even when they are set after this module is loaded.
function candidateBinaries(env = process.env) {
  return [env.CHROME_BIN, env.CHROMIUM_BIN, env.BROWSER_BIN, ...CANDIDATE_BINARIES];
}

function onPath(name, env = process.env) {
  const extensions = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// The full, ordered candidate list:
//   1. explicit operator overrides (CHROME_BIN / CHROMIUM_BIN / BROWSER_BIN),
//   2. bare names resolved on PATH,
//   3. the fixed well-known install locations,
//   4. the Playwright browser cache (self-discovery, last resort).
export function browserBinaryCandidates(env = process.env) {
  const resolved = [];
  for (const candidate of candidateBinaries(env)) {
    if (!candidate) continue;
    if (candidate.includes(path.sep)) {
      resolved.push(candidate);
    } else {
      // A bare name must actually resolve on PATH; otherwise the launcher would
      // claim a browser is available and then fail to spawn it.
      const found = onPath(candidate, env);
      if (found) resolved.push(found);
    }
  }
  resolved.push(...playwrightChromiumCandidates(env));
  return resolved;
}

function firstExistingBinary(env = process.env) {
  for (const candidate of browserBinaryCandidates(env)) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export function browserBinaryAvailable() {
  return Boolean(firstExistingBinary(process.env));
}

/**
 * Absolute path to the browser binary that would be launched, or null.
 *
 * Resolution order: explicit env overrides -> PATH -> fixed install locations ->
 * the Playwright browser cache (self-discovery). When nothing is found this
 * returns null so the caller fails closed instead of launching a bogus binary.
 */
export function resolveBrowserBinary() {
  return firstExistingBinary(process.env);
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

// The ELF magic number (`0x7f 'E' 'L' 'F'`). Chromium's sandbox helper is always
// a native ELF executable. Verifying the signature BEFORE granting setuid-root
// prevents a non-ELF file (for example a shell script dropped by a
// lower-privileged user) from ever being elevated to setuid-root.
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** True when `file` is a regular, non-symlink file whose first 4 bytes are ELF. */
export function isElfExecutable(file) {
  try {
    if (!lstatSync(file).isFile()) return false; // never follow/trust a symlink
    const fd = openSync(file, 'r');
    try {
      const header = Buffer.alloc(4);
      return readSync(fd, header, 0, 4, 0) === 4 && header.equals(ELF_MAGIC);
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * A directory is safe to install a setuid-root helper into only when it is owned
 * by root and is not writable by group or other. Otherwise a lower-privileged
 * user could swap the helper for a malicious binary before an admin runs the
 * setup (or between this check and the browser launch), turning the setuid grant
 * into a privilege-escalation primitive.
 */
export function isSafeHelperDirectory(dir) {
  try {
    const stats = lstatSync(dir);
    return stats.isDirectory() && stats.uid === 0 && (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * True when a root-owned, setuid (4755), genuine-ELF sandbox helper sits next to
 * the binary. The ELF check keeps a non-ELF setuid file from being trusted as a
 * working sandbox helper.
 */
export function isSuidSandboxReady(binary) {
  for (const helper of sandboxHelperCandidates(binary)) {
    try {
      const stats = lstatSync(helper);
      if (stats.isFile() && (stats.mode & 0o4000) !== 0 && stats.uid === 0 && isElfExecutable(helper)) return true;
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
    // Only ever elevate a helper inside a root-owned, non-group/world-writable
    // directory. Granting setuid-root to a file an unprivileged user could have
    // planted -- or can later replace -- would be a privilege-escalation vector.
    if (!isSafeHelperDirectory(dir)) continue;
    const hyphen = path.join(dir, 'chrome-sandbox');
    const underscore = path.join(dir, 'chrome_sandbox');
    try {
      // Some builds ship the helper as `chrome_sandbox`; Chromium expects
      // `chrome-sandbox`. Materialise it only from a genuine ELF helper (never
      // following a symlink source).
      if (!existsSync(hyphen) && isElfExecutable(underscore)) {
        copyFileSync(underscore, hyphen);
      }
    } catch { /* not writable */ }
    for (const helper of [hyphen, underscore]) {
      try {
        const stats = lstatSync(helper);
        if (!stats.isFile()) continue; // never chmod a symlink
        // Verify the ELF signature before granting setuid-root.
        if (!isElfExecutable(helper)) continue;
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
