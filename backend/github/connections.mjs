import { createHash, randomBytes } from 'node:crypto';
import { id, now } from '../db/client.mjs';
import { encryptSecret, decryptSecret } from '../secrets/vault.mjs';

function hashToken(token) { return createHash('sha256').update(String(token)).digest('hex'); }

// OAuth CSRF protection: a single-use, user-bound, short-lived state value kept
// in the account_tokens table (hashed at rest). It is consumed exactly once so a
// replayed callback cannot mint a second connection.
export function issueOAuthState(db, userId) {
  const state = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  db.run('INSERT INTO account_tokens(id,user_id,kind,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)', id('acctok'), userId, 'github_oauth_state', hashToken(state), expiresAt, now());
  return state;
}

export function consumeOAuthState(db, userId, state) {
  const row = db.get('SELECT * FROM account_tokens WHERE token_hash=? AND kind=? AND user_id=? AND used_at IS NULL', hashToken(state), 'github_oauth_state', userId);
  if (!row || Date.parse(row.expires_at) <= Date.now()) throw new Error('GITHUB_OAUTH_STATE_INVALID');
  db.run('UPDATE account_tokens SET used_at=? WHERE id=? AND used_at IS NULL', now(), row.id);
  return true;
}

// Persist a tenant's GitHub credential. The token itself is encrypted at rest;
// only non-sensitive metadata (login, scope) is stored in the clear so the UI
// can show which account is connected without ever exposing the secret.
export function saveGitHubConnection(db, { tenantId, userId, login, scope, token, provider = 'oauth' }) {
  if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');
  if (!process.env.SECRETS_MASTER_KEY) throw new Error('SECRETS_MASTER_KEY_REQUIRED');
  const encrypted = encryptSecret(token);
  const timestamp = now();
  const existing = db.get('SELECT id FROM github_connections WHERE tenant_id=? AND provider=?', tenantId, provider);
  if (existing) {
    db.run('UPDATE github_connections SET user_id=?,login=?,scope=?,token_encrypted=?,updated_at=? WHERE id=?', userId ?? null, login ?? null, scope ?? null, encrypted, timestamp, existing.id);
    return { id: existing.id, login: login ?? null, scope: scope ?? null, provider };
  }
  const connectionId = id('ghconn');
  db.run('INSERT INTO github_connections(id,tenant_id,user_id,provider,login,scope,token_encrypted,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', connectionId, tenantId, userId ?? null, provider, login ?? null, scope ?? null, encrypted, timestamp, timestamp);
  return { id: connectionId, login: login ?? null, scope: scope ?? null, provider };
}

export function getGitHubConnection(db, tenantId) {
  return db.get('SELECT id,login,scope,provider,updated_at FROM github_connections WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 1', tenantId) ?? null;
}

// Resolve the token to use for a tenant: prefer the stored (encrypted) OAuth
// token, then fall back to an operator-provided GITHUB_TOKEN. Returns null when
// nothing is configured so callers can fail closed.
export function resolveGitHubToken(db, tenantId, env = process.env) {
  const row = db.get('SELECT token_encrypted FROM github_connections WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 1', tenantId);
  if (row?.token_encrypted) return decryptSecret(row.token_encrypted);
  return env.GITHUB_TOKEN || env.GH_TOKEN || null;
}

export function deleteGitHubConnection(db, tenantId) {
  return db.run('DELETE FROM github_connections WHERE tenant_id=?', tenantId);
}
