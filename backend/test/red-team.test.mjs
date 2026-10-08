import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../secrets/vault.mjs';
import { assertSafeUrl, assertSafeUrlResolved, assertWorkspacePath, isPrivateAddress, pinnedLookup, pinnedRequest, resolveSafeUrl, safeFetchText } from '../security/validators.mjs';
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

/* ------------------- DNS rebinding / TOCTOU hardening -------------------- */

test('red-team resolveSafeUrl validates the resolved addresses and returns them for pinning', async () => {
  const { url, addresses } = await resolveSafeUrl('http://rebind.example/', { resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(url.hostname, 'rebind.example');
  assert.deepEqual(addresses, ['93.184.216.34']);
  // A name that resolves to a private/metadata address is rejected.
  await assert.rejects(() => resolveSafeUrl('http://rebind.example/', { resolver: async () => [{ address: '127.0.0.1', family: 4 }] }), /SSRF_TARGET_NOT_ALLOWED/);
  await assert.rejects(() => resolveSafeUrl('http://rebind.example/', { resolver: async () => [{ address: '169.254.169.254', family: 4 }] }), /SSRF_TARGET_NOT_ALLOWED/);
  // If ANY resolved address is private the whole name is rejected (mixed answer).
  await assert.rejects(() => resolveSafeUrl('http://rebind.example/', { resolver: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] }), /SSRF_TARGET_NOT_ALLOWED/);
  await assert.rejects(() => resolveSafeUrl('http://rebind.example/', { resolver: async () => { throw new Error('ENOTFOUND'); } }), /URL_HOST_UNRESOLVABLE/);
});

test('red-team pinnedLookup returns only the validated addresses (no second DNS resolution)', async () => {
  const lookup = pinnedLookup(['93.184.216.34']);
  const all = await new Promise((resolve, reject) => lookup('attacker.example', { all: true }, (error, records) => (error ? reject(error) : resolve(records))));
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);
  const single = await new Promise((resolve, reject) => lookup('attacker.example', { family: 4 }, (error, address, family) => (error ? reject(error) : resolve({ address, family }))));
  assert.deepEqual(single, { address: '93.184.216.34', family: 4 });
});

test('red-team pinnedRequest connects to the pinned address, never re-resolving the hostname', async () => {
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('pinned-ok'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    // `rebind.invalid` does not resolve at all; a successful response proves the
    // socket used the pinned address rather than performing its own lookup.
    const response = await pinnedRequest(new URL(`http://rebind.invalid:${port}/`), ['127.0.0.1']);
    assert.equal(response.status, 200);
    assert.equal(response.body, 'pinned-ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('red-team safeFetchText applies the guard before connecting (rebinding host rejected)', async () => {
  await assert.rejects(() => safeFetchText('http://rebind.example/', { resolver: async () => [{ address: '127.0.0.1', family: 4 }] }), /SSRF_TARGET_NOT_ALLOWED/);
  await assert.rejects(() => safeFetchText('http://169.254.169.254/'), /SSRF_TARGET_NOT_ALLOWED/);
});

// Best-effort loopback alias so a "public" address can be served locally without
// touching the real network. Needs root (or passwordless sudo) + iproute2; when
// unavailable the test skips honestly instead of faking a pass.
function ipCommand(args) {
  for (const [bin, prefix] of [['ip', []], ['sudo', ['-n', 'ip']]]) {
    const result = spawnSync(bin, [...prefix, ...args], { encoding: 'utf8' });
    if (result.status === 0) return true;
  }
  return false;
}

test('red-team safeFetchText pins the validated address and re-validates redirects', async (t) => {
  const alias = '203.0.113.10'; // TEST-NET-3: public per the classifier, served on lo
  if (!ipCommand(['addr', 'add', `${alias}/32`, 'dev', 'lo'])) { t.skip('cannot add a loopback alias (needs root/iproute2)'); return; }
  const server = createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/plain' }); response.end('composed-ok');
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, alias, resolve); });
    const port = server.address().port;
    const resolver = async () => [{ address: alias, family: 4 }];
    // The name resolves (via the injected resolver) to a PUBLIC address we control;
    // the guard passes and the socket is pinned to exactly that address.
    const response = await safeFetchText(`http://rebind.example:${port}/`, { resolver });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'composed-ok');
    // A redirect to a private/metadata address is re-validated and rejected.
    await assert.rejects(() => safeFetchText(`http://rebind.example:${port}/redirect`, { resolver }), /SSRF_TARGET_NOT_ALLOWED/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    ipCommand(['addr', 'del', `${alias}/32`, 'dev', 'lo']);
  }
});
