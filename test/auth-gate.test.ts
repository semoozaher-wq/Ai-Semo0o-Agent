import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AUTH_MESSAGES, humanizeAuthError } from '../src/services/api/auth-errors';

// -----------------------------------------------------------------------------
// Frontend side of the private-app gate.
//
// 1. The Arabic copy for every gate error code is present and humanized.
// 2. A source-level regression guard proves the old device auto-registration
//    backdoor (which silently created `device-…@local.semo0o` accounts) is gone
//    and that the client now restores/validates a real session instead.
// -----------------------------------------------------------------------------

test('humanizeAuthError maps known gate codes to Arabic copy', () => {
  assert.equal(humanizeAuthError(new Error('ACCESS_KEY_INVALID')), AUTH_MESSAGES.ACCESS_KEY_INVALID);
  assert.equal(humanizeAuthError(new Error('REGISTRATION_DISABLED')), AUTH_MESSAGES.REGISTRATION_DISABLED);
  assert.equal(humanizeAuthError(new Error('EMAIL_VERIFICATION_REQUIRED')), AUTH_MESSAGES.EMAIL_VERIFICATION_REQUIRED);
  assert.equal(humanizeAuthError(new Error('AUTH_REQUIRED')), AUTH_MESSAGES.AUTH_REQUIRED);
  assert.equal(humanizeAuthError(new Error('MFA_REQUIRED')), AUTH_MESSAGES.MFA_REQUIRED);
});

test('humanizeAuthError passes unknown codes through unchanged', () => {
  assert.equal(humanizeAuthError(new Error('SOME_NEW_BACKEND_ERROR')), 'SOME_NEW_BACKEND_ERROR');
  assert.equal(humanizeAuthError('RAW_STRING_CODE'), 'RAW_STRING_CODE');
});

test('every gate-critical code has non-empty Arabic copy', () => {
  const required = [
    'AUTH_REQUIRED',
    'INVALID_CREDENTIALS',
    'MFA_REQUIRED',
    'MFA_CODE_INVALID',
    'ACCESS_KEY_INVALID',
    'REGISTRATION_DISABLED',
    'EMAIL_ALREADY_REGISTERED',
    'PASSWORD_POLICY_FAILED',
    'EMAIL_VERIFICATION_REQUIRED',
    'BACKEND_API_NOT_CONFIGURED',
    'RATE_LIMITED',
  ];
  for (const code of required) {
    assert.ok(typeof AUTH_MESSAGES[code] === 'string' && AUTH_MESSAGES[code].length > 0, `missing copy for ${code}`);
  }
});

test('client no longer auto-provisions anonymous device accounts', () => {
  const source = readFileSync(new URL('../src/services/api/client.ts', import.meta.url), 'utf8');
  // The removed backdoor: an ensureSession() that auto-registered a device user.
  assert.equal(source.includes('ensureSession'), false, 'ensureSession() backdoor must be gone');
  assert.equal(source.includes('local.semo0o'), false, 'anonymous device emails must be gone');
  assert.equal(source.includes('randomSecret'), false, 'device secret generation must be gone');
  assert.equal(source.includes('StoredBootstrap'), false, 'bootstrap device record must be gone');
});

test('client restores and enforces a real server-validated session', () => {
  const source = readFileSync(new URL('../src/services/api/client.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('restoreSession'), 'client must restore a persisted session');
  assert.ok(source.includes('/auth/session'), 'restore must validate against GET /auth/session');
  assert.ok(source.includes('requireSession'), 'authenticated calls must require a session');
  assert.ok(source.includes('AUTH_REQUIRED'), 'missing sessions must surface AUTH_REQUIRED');
  assert.ok(source.includes('getAccessPolicy'), 'client must read the deployment access policy');
  assert.ok(source.includes('/auth/policy'), 'policy must come from GET /auth/policy');
});

test('the store screen and store tab are removed (platform, not a store)', () => {
  const tabs = readFileSync(new URL('../app/(tabs)/_layout.tsx', import.meta.url), 'utf8');
  assert.equal(tabs.includes("name: 'store'"), false, 'the store tab must be gone');
  assert.ok(tabs.includes("name: 'studio'"), 'the creation studio tab must exist');
  assert.ok(tabs.includes("name: 'operations'"), 'the operations tab must exist');
});
