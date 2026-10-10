/**
 * Account-scoped storage keys — the user-data isolation boundary.
 *
 * The KV store historically persisted every slice under a single, generic key
 * (`semo0o:chat.conversations`, `semo0o:agents.tasks`, …). Because those keys
 * were NOT bound to the signed-in account, a second user signing in on the same
 * device/browser inherited the previous user's conversations, messages, files
 * and tasks.
 *
 * This module makes the user-owned slices account-scoped: while a session is
 * active, the physical key is namespaced with a stable, non-reversible hash of
 * the account identity (`tenantId:userId`). A different account therefore reads
 * a different namespace and can never observe another user's data. Device-level
 * preferences (theme, language, …) are intentionally NOT scoped so they survive
 * a sign-out.
 *
 * The module is PURE — it imports neither react-native nor any storage backend —
 * so the exact scoping rules are unit-testable in isolation.
 */

export const STORAGE_KEYS = {
  installedAgents: 'store.installed',
  conversations: 'chat.conversations',
  messages: 'chat.messages',
  tasks: 'agents.tasks',
  files: 'files.entries',
  settings: 'app.settings',
  theme: 'app.theme',
  usage: 'analytics.usage',
} as const;

/** The workspace VFS slice (`<files>.workspace`), also account-owned. */
export const WORKSPACE_STORAGE_KEY = `${STORAGE_KEYS.files}.workspace`;

/**
 * The slices that belong to a single account. Everything here is namespaced per
 * account; every other key is device-level and shared across accounts.
 */
export const ACCOUNT_SCOPED_KEYS: ReadonlySet<string> = new Set<string>([
  STORAGE_KEYS.conversations,
  STORAGE_KEYS.messages,
  STORAGE_KEYS.tasks,
  STORAGE_KEYS.files,
  STORAGE_KEYS.usage,
  STORAGE_KEYS.installedAgents,
  WORKSPACE_STORAGE_KEY,
]);

/** Namespace segment used when no account is active (pre-login / post-logout). */
const SCOPE_SEGMENT = 'acct';
export const ANONYMOUS_SCOPE = '__anonymous__';

/** FNV-1a over a seed — combined into a wide, non-reversible scope token. */
function fnv1a(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A stable, non-reversible token for an account identity. The raw tenant/user
 * ids are never written into a storage key, so the key names cannot be used to
 * enumerate accounts on a shared device.
 */
export function hashAccountId(input: string): string {
  const a = fnv1a(input, 0x811c9dc5);
  const b = fnv1a(`${input}#semo0o`, 0x01000193);
  return `${a.toString(36)}${b.toString(36)}`;
}

/**
 * The scope token for an account identity, or `null` when the identity is not
 * usable (no user id). The tenant is folded in so two users with a colliding id
 * in different tenants still get distinct namespaces.
 */
export function accountScopeFor(
  identity: { tenantId?: string | null; id?: string | null } | null | undefined,
): string | null {
  const tenant = String(identity?.tenantId ?? '').trim();
  const user = String(identity?.id ?? '').trim();
  if (!user) return null;
  return hashAccountId(`${tenant}:${user}`);
}

let currentScope: string | null = null;

/** Bind the active account namespace. Pass `null` to clear it. */
export function setAccountScope(scope: string | null): void {
  currentScope = typeof scope === 'string' && scope.trim() ? scope.trim() : null;
}

/** The active account namespace, or `null` when anonymous. */
export function getAccountScope(): string | null {
  return currentScope;
}

/** Drop the active account namespace (sign-out). */
export function clearAccountScope(): void {
  currentScope = null;
}

/** True when a logical key holds account-owned data. */
export function isAccountScoped(key: string): boolean {
  return ACCOUNT_SCOPED_KEYS.has(key);
}

/**
 * Resolve the physical key for a logical key. Account-owned slices are placed
 * under `acct.<scope>.<key>`; when no account is active they go to a reserved
 * anonymous namespace (never the legacy unscoped key), so a signed-out visitor
 * can never read a real account's slice and an anonymous write can never leak
 * into a future account's namespace.
 */
export function scopeStorageKey(
  key: string,
  scope: string | null = currentScope,
): string {
  if (!ACCOUNT_SCOPED_KEYS.has(key)) return key;
  return `${SCOPE_SEGMENT}.${scope ?? ANONYMOUS_SCOPE}.${key}`;
}
