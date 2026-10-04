import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSecrets } from '../secrets/vault.mjs';
import { assertSafeUrl, assertWorkspacePath } from '../security/validators.mjs';
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
  for (const tool of ['image.generate', 'image.analyze', 'calendar.schedule', 'email.send']) {
    await assert.rejects(() => registry.run(tool, {}), new RegExp(`TOOL_CONNECTOR_NOT_CONFIGURED:${tool}`));
  }
});
