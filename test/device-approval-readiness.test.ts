import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// -----------------------------------------------------------------------------
// Device approval — READINESS GUARD (documented limitation).
//
// The backend can gate logins from new devices (`REQUIRE_DEVICE_APPROVAL`), but
// the feature is NOT production-ready end to end:
//   - the client does not send a `deviceId` on login,
//   - the auth store does not handle the `202 { deviceApprovalRequired }`
//     response (the generic `request<T>` helper would mis-parse it as a session),
//   - there is no owner UI to list / approve / reject device requests.
//
// Enabling `REQUIRE_DEVICE_APPROVAL` in production would therefore BLOCK
// new-device logins. These assertions document that gap on purpose: they will
// fail the moment the feature is implemented, which is the signal to update this
// file (invert the assertions) and remove the boot warning in `server.mjs`.
// -----------------------------------------------------------------------------

const client = readFileSync(new URL('../src/services/api/client.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('../src/store/useAuthStore.ts', import.meta.url), 'utf8');

test('device approval is not ready: the client does not send a deviceId', () => {
  assert.equal(
    client.includes('deviceId'),
    false,
    'client.ts must not reference deviceId until device approval is implemented end to end',
  );
});

test('device approval is not ready: the auth flow does not handle the 202 response', () => {
  assert.equal(store.includes('deviceApprovalRequired'), false, 'the auth store must not pretend to handle 202 device-approval responses yet');
  assert.equal(store.includes('deviceRequestId'), false, 'the auth store must not reference device request ids yet');
});
