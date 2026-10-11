import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { launchLocalChromium, enableSuidSandbox, isSuidSandboxReady } from '../browser/launcher.mjs';

/**
 * Guards the AppArmor / user-namespace sandbox handling in the browser launcher.
 *
 * On Ubuntu 23.10+/24.04 (and CI runners/containers) unprivileged user namespaces
 * are restricted, so Chromium aborts with "No usable sandbox!". The launcher must
 * NEVER work around that by disabling the sandbox (`--no-sandbox` weakens
 * security); it must surface a distinct, actionable error and prefer Chromium's
 * SUID sandbox instead. These tests use tiny fake "browsers" so they run anywhere.
 */
const isWindows = process.platform === 'win32';

async function withFakeBrowser(body, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launcher-test-'));
  const saved = { bin: process.env.CHROME_BIN, sandbox: process.env.BROWSER_NO_SANDBOX };
  try {
    const fake = path.join(dir, 'fake-chrome');
    await writeFile(fake, body, { mode: 0o755 });
    process.env.CHROME_BIN = fake;
    delete process.env.BROWSER_NO_SANDBOX;
    return await run(fake, dir);
  } finally {
    if (saved.bin === undefined) delete process.env.CHROME_BIN; else process.env.CHROME_BIN = saved.bin;
    if (saved.sandbox === undefined) delete process.env.BROWSER_NO_SANDBOX; else process.env.BROWSER_NO_SANDBOX = saved.sandbox;
    await rm(dir, { recursive: true, force: true });
  }
}

test('launcher maps a sandbox refusal to BROWSER_SANDBOX_UNAVAILABLE (never disables the sandbox)', { skip: isWindows ? 'posix shell fake' : false }, async () => {
  await withFakeBrowser(
    '#!/bin/sh\necho "FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:128] No usable sandbox!" 1>&2\nexit 1\n',
    async () => {
      await assert.rejects(() => launchLocalChromium({ timeoutMs: 5000 }), /BROWSER_SANDBOX_UNAVAILABLE/);
    },
  );
});

test('launcher keeps a generic early exit as BROWSER_EXITED_EARLY (not a sandbox error)', { skip: isWindows ? 'posix shell fake' : false }, async () => {
  await withFakeBrowser('#!/bin/sh\necho "boom" 1>&2\nexit 3\n', async () => {
    await assert.rejects(() => launchLocalChromium({ timeoutMs: 5000 }), /BROWSER_EXITED_EARLY:3/);
  });
});

test('enableSuidSandbox makes the helper root-owned and setuid when privileged (no-op otherwise)', { skip: isWindows ? 'posix shell fake' : false }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'launcher-suid-'));
  try {
    const binary = path.join(dir, 'chrome');
    await writeFile(binary, '#!/bin/sh\n', { mode: 0o755 });
    // Some builds ship the helper as `chrome_sandbox`; Chromium expects `chrome-sandbox`.
    await writeFile(path.join(dir, 'chrome_sandbox'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(isSuidSandboxReady(binary), false, 'a plain helper is not setuid');
    const ready = enableSuidSandbox(binary);
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      assert.equal(ready, true, 'root can enable the SUID sandbox');
      assert.equal(isSuidSandboxReady(binary), true);
    } else {
      assert.equal(ready, false, 'a non-root caller cannot chown the helper');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('helper lookup follows a symlinked launcher to the real binary directory', { skip: isWindows ? 'posix symlink fake' : false }, async () => {
  // Mirrors real installs: /usr/local/bin/google-chrome -> /opt/chrome/chrome,
  // where the helper sits next to the REAL binary. Chromium resolves the symlink
  // to find `chrome-sandbox`, so the launcher must too.
  const realDir = await mkdtemp(path.join(os.tmpdir(), 'launcher-real-'));
  const linkDir = await mkdtemp(path.join(os.tmpdir(), 'launcher-link-'));
  try {
    const realBinary = path.join(realDir, 'chrome');
    await writeFile(realBinary, '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(path.join(realDir, 'chrome_sandbox'), '#!/bin/sh\n', { mode: 0o755 });
    const link = path.join(linkDir, 'google-chrome');
    await symlink(realBinary, link);
    assert.equal(isSuidSandboxReady(link), false, 'a plain helper is not setuid yet');
    const ready = enableSuidSandbox(link);
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      assert.equal(ready, true, 'root can enable the SUID sandbox through the symlink');
      assert.equal(isSuidSandboxReady(link), true);
    } else {
      assert.equal(ready, false, 'a non-root caller cannot chown the helper');
    }
  } finally {
    await rm(realDir, { recursive: true, force: true });
    await rm(linkDir, { recursive: true, force: true });
  }
});
