import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../secrets/vault.mjs';
import { assertSafeUrl, assertSafeUrlResolved, assertWorkspacePath, isPrivateAddress } from '../security/validators.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

test('red-team blocks SSRF targets and URL credential exfiltration', () => {
  for (const url of [
    'http://127.0.0.1:8080/admin',
    'http://10.0.0.1/internal',
    'http://192.168.1.1/router',
    'http://169.254.169.254/latest/meta-data',
    'http://localhost:8787/health',
    'https://user:password@example.com/private',
  ]) assert.throws(() => assertSafeUrl(url), /SSRF_TARGET_NOT_ALLOWED|PRIVATE_NETWORK_NOT_ALLOWED|URL_CREDENTIALS_NOT_ALLOWED/);
});

test('red-team blocks traversal and normalizes safe workspace paths', () => {
  for (const value of ['../secret', '..\\secret', '/etc/passwd', 'nested/../../secret', '']) assert.throws(() => assertWorkspacePath(value), /INVALID_PATH|PATH_OUTSIDE_WORKSPACE/);
  assert.equal(assertWorkspacePath('nested/./file.txt'), 'nested/file.txt');
});

test('red-team never exposes configured secrets through log redaction', () => {
  const secret = 'sk-live-example-secret';
  const redacted = redactSecrets({ error: `provider failed with ${secret}` }, [secret]);
  assert.equal(redacted.includes(secret), false);
  assert.equal(redacted.includes('[REDACTED]'), true);
});

test('unconfigured dangerous integrations fail closed instead of returning fake success', async () => {
  const registry = createLiveToolRegistry();
  for (const tool of ['image.generate', 'image.analyze', 'calendar.schedule', 'email.send', 'browser.run']) {
    await assert.rejects(() => registry.run(tool, {}), new RegExp(`TOOL_CONNECTOR_NOT_CONFIGURED:${tool}`));
  }
  assert.ok(registry.status().unwired.includes('browser.run'));
});

test('red-team private-address classifier blocks metadata and internal ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be classified private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be classified public`);
  }
});

test('red-team DNS-aware SSRF guard rejects literals and unresolvable hosts', async () => {
  await assert.rejects(() => assertSafeUrlResolved('http://169.254.169.254/'), /SSRF_TARGET_NOT_ALLOWED/);
  await assert.rejects(() => assertSafeUrlResolved('http://metadata.google.internal/'), /SSRF_TARGET_NOT_ALLOWED/);
  await assert.rejects(() => assertSafeUrlResolved('http://this-host-should-not-resolve.invalid/'), /URL_HOST_UNRESOLVABLE/);
});

test('red-team blocks symlink escape out of the workspace', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-redteam-'));
  try {
    await writeFile(path.join(dir, 'inside.txt'), 'ok');
    await symlink('/etc', path.join(dir, 'escape'));
    const registry = createLiveToolRegistry();
    await assert.rejects(() => registry.run('files.read', { path: 'escape/passwd' }, { workspaceRoot: dir }), /PATH_OUTSIDE_WORKSPACE/);
    await assert.rejects(() => registry.run('files.read', { path: '../outside' }, { workspaceRoot: dir }), /PATH_OUTSIDE_WORKSPACE|INVALID_PATH/);
    const ok = await registry.run('files.read', { path: 'inside.txt' }, { workspaceRoot: dir });
    assert.equal(ok.output.content, 'ok');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
