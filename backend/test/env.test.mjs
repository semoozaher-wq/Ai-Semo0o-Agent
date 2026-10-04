import assert from 'node:assert/strict';
import test from 'node:test';
import { assertEnv, validateEnv } from '../config/env.mjs';

const STRONG_KEY = 'a'.repeat(64); // 32 bytes hex

test('env validation is permissive outside production but warns without providers', () => {
  const result = validateEnv({ NODE_ENV: 'development' });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.warnings.includes('NO_LLM_PROVIDER_CONFIGURED'));
});

test('env validation fails closed in production when required values are missing', () => {
  const result = validateEnv({ NODE_ENV: 'production' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('MISSING_SECRETS_MASTER_KEY'));
  assert.ok(result.errors.includes('MISSING_DATABASE_FILE'));
  assert.ok(result.errors.includes('MISSING_WORKSPACE_ROOT'));
});

test('env validation rejects dangerous production configuration', () => {
  const result = validateEnv({
    NODE_ENV: 'production',
    SECRETS_MASTER_KEY: 'short',
    DATABASE_FILE: '/var/lib/semo0o/agent.sqlite',
    WORKSPACE_ROOT: 'relative/path',
    ALLOWED_ORIGIN: '*',
    OPENAI_API_KEY: 'sk-test',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('SECRETS_MASTER_KEY_MUST_BE_32_BYTES'));
  assert.ok(result.errors.includes('WORKSPACE_ROOT_MUST_BE_ABSOLUTE'));
  assert.ok(result.errors.includes('ALLOWED_ORIGIN_WILDCARD_FORBIDDEN'));
});

test('env validation accepts a complete production configuration', () => {
  const result = validateEnv({
    NODE_ENV: 'production',
    SECRETS_MASTER_KEY: STRONG_KEY,
    DATABASE_FILE: '/var/lib/semo0o/agent.sqlite',
    WORKSPACE_ROOT: '/var/lib/semo0o/workspaces',
    ALLOWED_ORIGIN: 'https://app.example.com',
    OPENAI_API_KEY: 'sk-test',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('assertEnv throws a classified error on invalid production config', () => {
  assert.throws(() => assertEnv({ NODE_ENV: 'production' }), (error) => error.code === 'ENV_VALIDATION_FAILED' && error.errors.length > 0);
});
