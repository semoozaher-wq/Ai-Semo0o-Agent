import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCOUNT_SCOPED_KEYS,
  ANONYMOUS_SCOPE,
  STORAGE_KEYS,
  accountScopeFor,
  clearAccountScope,
  getAccountScope,
  hashAccountId,
  isAccountScoped,
  scopeStorageKey,
  setAccountScope,
} from '../src/services/storage/scope';

// -----------------------------------------------------------------------------
// User-data isolation boundary.
//
// The KV store persists user-owned slices (conversations, messages, files,
// tasks, installed agents, usage, workspace). Historically every slice used a
// single generic key, so a second account signing in on the same device
// inherited the previous account's data. These tests prove the physical key for
// an account-owned slice is namespaced by the signed-in account, that a
// different account can never resolve another account's key, and that
// device-level preferences stay unscoped.
//
// `scope.ts` is deliberately pure (no react-native, no storage backend) so the
// exact rules run under `tsx --test`.
// -----------------------------------------------------------------------------

// A faithful re-implementation of the WebKVStore key derivation, so we can
// simulate a real localStorage round-trip without importing react-native.
const PREFIX = 'semo0o:';
const physical = (logicalKey: string): string => `${PREFIX}${scopeStorageKey(logicalKey)}`;

function makeMemoryStore() {
  const map = new Map<string, string>();
  return {
    set(logicalKey: string, value: unknown) { map.set(physical(logicalKey), JSON.stringify(value)); },
    get<T>(logicalKey: string): T | null {
      const raw = map.get(physical(logicalKey));
      return raw == null ? null : (JSON.parse(raw) as T);
    },
    has(logicalKey: string) { return map.has(physical(logicalKey)); },
    rawKeys() { return [...map.keys()]; },
  };
}

test('device-level preferences are NOT account-scoped', () => {
  setAccountScope('acctA');
  assert.equal(scopeStorageKey(STORAGE_KEYS.theme), STORAGE_KEYS.theme);
  assert.equal(scopeStorageKey(STORAGE_KEYS.settings), STORAGE_KEYS.settings);
  assert.equal(isAccountScoped(STORAGE_KEYS.theme), false);
  assert.equal(isAccountScoped(STORAGE_KEYS.settings), false);
  clearAccountScope();
});

test('user-owned slices ARE account-scoped and carry the account namespace', () => {
  for (const key of ACCOUNT_SCOPED_KEYS) {
    assert.equal(isAccountScoped(key), true, `${key} must be account-scoped`);
  }
  setAccountScope('acctA');
  assert.equal(scopeStorageKey(STORAGE_KEYS.conversations), 'acct.acctA.chat.conversations');
  assert.equal(scopeStorageKey(STORAGE_KEYS.messages), 'acct.acctA.chat.messages');
  assert.equal(scopeStorageKey(STORAGE_KEYS.tasks), 'acct.acctA.agents.tasks');
  assert.equal(scopeStorageKey(STORAGE_KEYS.files), 'acct.acctA.files.entries');
  clearAccountScope();
});

test('signed-out writes land in the reserved anonymous namespace, never a real account', () => {
  clearAccountScope();
  assert.equal(getAccountScope(), null);
  assert.equal(scopeStorageKey(STORAGE_KEYS.conversations), `acct.${ANONYMOUS_SCOPE}.chat.conversations`);
  // The legacy unscoped key must never be produced for a user-owned slice.
  assert.notEqual(scopeStorageKey(STORAGE_KEYS.conversations), STORAGE_KEYS.conversations);
});

test('account A and account B resolve disjoint physical keys (no cross-read)', () => {
  const scopeA = accountScopeFor({ tenantId: 't1', id: 'user-a' })!;
  const scopeB = accountScopeFor({ tenantId: 't1', id: 'user-b' })!;
  assert.ok(scopeA && scopeB);
  assert.notEqual(scopeA, scopeB);

  setAccountScope(scopeA);
  const keyA = scopeStorageKey(STORAGE_KEYS.conversations);
  setAccountScope(scopeB);
  const keyB = scopeStorageKey(STORAGE_KEYS.conversations);
  assert.notEqual(keyA, keyB, 'two accounts must never share a physical key');
});

test('a second account cannot read the first account persisted data (switch simulation)', () => {
  const store = makeMemoryStore();
  const scopeA = accountScopeFor({ tenantId: 't1', id: 'user-a' })!;
  const scopeB = accountScopeFor({ tenantId: 't1', id: 'user-b' })!;

  // Account A signs in and writes a conversation.
  setAccountScope(scopeA);
  store.set(STORAGE_KEYS.conversations, [{ id: 'c1', title: 'A private thread' }]);
  assert.deepEqual(store.get(STORAGE_KEYS.conversations), [{ id: 'c1', title: 'A private thread' }]);

  // Account B signs in on the same device: must see NOTHING from A.
  setAccountScope(scopeB);
  assert.equal(store.get(STORAGE_KEYS.conversations), null, 'account B must not inherit account A data');
  assert.equal(store.has(STORAGE_KEYS.conversations), false);

  // Account A signs back in: its own data is still there.
  setAccountScope(scopeA);
  assert.deepEqual(store.get(STORAGE_KEYS.conversations), [{ id: 'c1', title: 'A private thread' }]);

  // Signing out exposes only the anonymous namespace, never A's slice.
  clearAccountScope();
  assert.equal(store.get(STORAGE_KEYS.conversations), null, 'a signed-out visitor must not read a real account slice');
  assert.equal(store.rawKeys().some((k) => k.includes(ANONYMOUS_SCOPE)), false);
});

test('the raw account id is never written into a storage key', () => {
  const scope = accountScopeFor({ tenantId: 'tenant-secret', id: 'user-42' })!;
  assert.equal(scope.includes('user-42'), false);
  assert.equal(scope.includes('tenant-secret'), false);
  setAccountScope(scope);
  const key = scopeStorageKey(STORAGE_KEYS.files);
  assert.equal(key.includes('user-42'), false);
  assert.equal(key.includes('tenant-secret'), false);
  clearAccountScope();
});

test('accountScopeFor is stable, tenant-aware, and null without an id', () => {
  assert.equal(accountScopeFor(null), null);
  assert.equal(accountScopeFor(undefined), null);
  assert.equal(accountScopeFor({ id: '' }), null);
  assert.equal(accountScopeFor({ tenantId: 't1' }), null);
  // Same identity → same scope (stable across cold starts).
  assert.equal(accountScopeFor({ tenantId: 't1', id: 'u1' }), accountScopeFor({ tenantId: 't1', id: 'u1' }));
  // Same user id in different tenants → distinct scopes.
  assert.notEqual(accountScopeFor({ tenantId: 't1', id: 'u1' }), accountScopeFor({ tenantId: 't2', id: 'u1' }));
});

test('hashAccountId is deterministic and collision-resistant for distinct inputs', () => {
  assert.equal(hashAccountId('t1:u1'), hashAccountId('t1:u1'));
  assert.notEqual(hashAccountId('t1:u1'), hashAccountId('t1:u2'));
  assert.notEqual(hashAccountId('t1:u1'), hashAccountId('t2:u1'));
  assert.ok(hashAccountId('t1:u1').length >= 8);
});

test('setAccountScope trims/ignores empty values and clearAccountScope resets', () => {
  setAccountScope('  scopeX  ');
  assert.equal(getAccountScope(), 'scopeX');
  setAccountScope('');
  assert.equal(getAccountScope(), null);
  setAccountScope('scopeY');
  clearAccountScope();
  assert.equal(getAccountScope(), null);
});
