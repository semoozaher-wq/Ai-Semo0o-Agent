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
 * Exit codes:
 *   0 = the SUID sandbox is enabled (or was already enabled); OR no browser is
 *       installed at all and BROWSER_SANDBOX_REQUIRED is not set. The latter is a
 *       DOCUMENTED no-op (there is nothing to sandbox; the browser smoke/E2E
 *       steps self-skip), not a masked failure.
 *   1 = a browser IS present but the helper could not be enabled (usually: not
 *       run as root, a non-ELF/world-writable helper, or no privilege to
 *       chown/chmod); OR no browser is present while BROWSER_SANDBOX_REQUIRED is
 *       set (used by CI where a browser is guaranteed to be installed).
 */
import { resolveBrowserBinary, isSuidSandboxReady, enableSuidSandbox } from '../backend/browser/launcher.mjs';

const required = /^(1|true|yes|on)$/i.test(String(process.env.BROWSER_SANDBOX_REQUIRED ?? '').trim());

const binary = resolveBrowserBinary();
if (!binary) {
  if (required) {
    process.stderr.write(
      'No Chromium/Chrome binary found, but BROWSER_SANDBOX_REQUIRED is set. Install a browser or set CHROME_BIN/CHROMIUM_BIN/BROWSER_BIN.\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    'SKIPPED: no Chromium/Chrome binary found; nothing to sandbox (set BROWSER_SANDBOX_REQUIRED=1 to fail instead).\n',
  );
  process.exit(0);
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
  `Could not enable the SUID sandbox for ${binary}. Re-run with sudo/root: the helper must be a root-owned, setuid (mode 4755) ELF binary inside a root-owned directory.\n`,
);
process.exit(1);
