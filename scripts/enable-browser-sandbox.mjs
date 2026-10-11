#!/usr/bin/env node
/**
 * scripts/enable-browser-sandbox.mjs
 *
 * Enable Chromium's SUID sandbox for the locally installed browser so it can run
 * WITHOUT disabling its sandbox on hosts where AppArmor restricts unprivileged
 * user namespaces (Ubuntu 23.10+/24.04, GitHub-hosted runners, containers).
 *
 * Chromium's Linux sandbox has two mechanisms:
 *   1. the NAMESPACE sandbox, which needs unprivileged user namespaces, and
 *   2. the SUID sandbox, a root-owned, setuid `chrome-sandbox` helper next to the
 *      browser binary.
 * When mechanism 1 is blocked, mechanism 2 keeps the sandbox ON -- unlike
 * `--no-sandbox`, which removes it. This script makes the helper root-owned and
 * setuid (mode 4755), so the browser starts sandboxed again.
 *
 * Run it with the privilege needed to chown/chmod the helper, e.g.:
 *   sudo node scripts/enable-browser-sandbox.mjs
 *
 * Exit codes: 0 = sandbox enabled (or already enabled); 1 = no browser found or
 * the helper could not be enabled (usually: not run as root).
 */
import { resolveBrowserBinary, isSuidSandboxReady, enableSuidSandbox } from '../backend/browser/launcher.mjs';

const binary = resolveBrowserBinary();
if (!binary) {
  process.stderr.write('No Chromium/Chrome binary found (set CHROME_BIN/CHROMIUM_BIN/BROWSER_BIN).\n');
  process.exit(1);
}
if (isSuidSandboxReady(binary)) {
  process.stdout.write(`SUID sandbox already enabled for ${binary}\n`);
  process.exit(0);
}
if (enableSuidSandbox(binary)) {
  process.stdout.write(`SUID sandbox enabled for ${binary}\n`);
  process.exit(0);
}
process.stderr.write(
  `Could not enable the SUID sandbox for ${binary}. Re-run with sudo/root: the helper must be root-owned and setuid (mode 4755).\n`,
);
process.exit(1);
