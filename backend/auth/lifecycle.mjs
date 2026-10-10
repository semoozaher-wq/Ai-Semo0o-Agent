import { createHmac, randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../secrets/vault.mjs';
import { hash, id, now } from '../db/client.mjs';

const TOKEN_DAYS = { email_verification: 2, password_reset: 1 };
const emailOf = (value) => String(value ?? '').trim().toLowerCase();
const expiry = (days) => new Date(Date.now() + days * 86400000).toISOString();

function rawToken() { return randomBytes(32).toString('base64url'); }

function recoveryCode() { return randomBytes(8).toString('hex').toUpperCase(); }

export function generateRecoveryCodes(db, userId, count = 10) {
  if (!Number.isInteger(count) || count < 5 || count > 20) throw new Error('INVALID_RECOVERY_CODE_COUNT');
  const created = now();
  const codes = Array.from({ length: count }, recoveryCode);
  db.transaction(() => {
    db.run('DELETE FROM recovery_codes WHERE user_id=?', userId);
    for (const code of codes) db.run('INSERT INTO recovery_codes(id,user_id,code_hash,created_at) VALUES(?,?,?,?)', id('recovery'), userId, hash(code), created);
  });
  return codes;
}

export function consumeRecoveryCode(db, userId, code) {
  const normalized = String(code ?? '').trim().toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(normalized)) return false;
  const row = db.get('SELECT id FROM recovery_codes WHERE user_id=? AND code_hash=? AND used_at IS NULL', userId, hash(normalized));
  if (!row) return false;
  return db.run('UPDATE recovery_codes SET used_at=? WHERE id=? AND used_at IS NULL', now(), row.id).changes === 1;
}

export function issueAccountToken(db, userId, kind) {
  if (!['email_verification', 'password_reset'].includes(kind)) throw new Error('INVALID_ACCOUNT_TOKEN_KIND');
  const token = rawToken();
  db.run('INSERT INTO account_tokens(id,user_id,kind,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)', id('acctok'), userId, kind, hash(token), expiry(TOKEN_DAYS[kind]), now());
  return token;
}

export function consumeAccountToken(db, token, kind) {
  const row = db.get('SELECT * FROM account_tokens WHERE token_hash=? AND kind=? AND used_at IS NULL', hash(token), kind);
  if (!row || Date.parse(row.expires_at) <= Date.now()) throw new Error('ACCOUNT_TOKEN_INVALID_OR_EXPIRED');
  db.run('UPDATE account_tokens SET used_at=? WHERE id=? AND used_at IS NULL', now(), row.id);
  return row;
}

export function verifyEmail(db, token) {
  const row = consumeAccountToken(db, token, 'email_verification');
  db.run('UPDATE users SET email_verified_at=? WHERE id=?', now(), row.user_id);
  return db.get('SELECT id,email,email_verified_at FROM users WHERE id=?', row.user_id);
}

export function resetPassword(db, token, password, passwordHash) {
  const row = consumeAccountToken(db, token, 'password_reset');
  db.run('UPDATE users SET password_hash=? WHERE id=?', passwordHash(password), row.user_id);
  db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now(), row.user_id);
  return { userId: row.user_id };
}

export function createInvitation(db, { tenantId, invitedBy, email, role }) {
  if (!['admin', 'member', 'viewer'].includes(role)) throw new Error('INVALID_INVITE_ROLE');
  const normalized = emailOf(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('INVALID_INVITE_EMAIL');
  const token = rawToken();
  const created = now();
  const invitationId = id('invite');
  const expiresAt = expiry(7);
  db.run('INSERT INTO invitations(id,tenant_id,invited_by,email,role,token_hash,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)', invitationId, tenantId, invitedBy, normalized, role, hash(token), expiresAt, created);
  return { invitationId, token, expiresAt };
}

export function acceptInvitation(db, { token, userId }) {
  const invite = db.get('SELECT * FROM invitations WHERE token_hash=? AND accepted_at IS NULL', hash(token));
  if (!invite || Date.parse(invite.expires_at) <= Date.now()) throw new Error('INVITATION_INVALID_OR_EXPIRED');
  const user = db.get('SELECT id,email FROM users WHERE id=?', userId);
  if (!user || emailOf(user.email) !== invite.email) throw new Error('INVITATION_EMAIL_MISMATCH');
  db.transaction(() => {
    db.run('INSERT OR REPLACE INTO tenant_members(tenant_id,user_id,role,status,created_at) VALUES(?,?,?,?,?)', invite.tenant_id, userId, invite.role, 'active', now());
    db.run('UPDATE invitations SET accepted_at=? WHERE id=? AND accepted_at IS NULL', now(), invite.id);
  });
  return db.get('SELECT tenant_id,user_id,role,status FROM tenant_members WHERE tenant_id=? AND user_id=?', invite.tenant_id, userId);
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of String(input).replace(/=+$/, '').toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error('INVALID_MFA_SECRET');
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
  return String(value).padStart(6, '0');
}

function base32Encode(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let output = '';
  for (let i = 0; i < bits.length; i += 5) output += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return output;
}

export function enableMfa(db, userId) {
  const base32 = base32Encode(randomBytes(20));
  if (!process.env.SECRETS_MASTER_KEY) throw new Error('SECRETS_MASTER_KEY_REQUIRED');
  db.run('UPDATE users SET mfa_secret=?,mfa_enabled=0 WHERE id=?', encryptSecret(base32), userId);
  return { secret: base32, recoveryCodes: generateRecoveryCodes(db, userId), enabled: false };
}

export function confirmMfa(db, userId, code) {
  const user = db.get('SELECT mfa_secret FROM users WHERE id=?', userId);
  if (!user?.mfa_secret || !verifyTotpSecret(decryptSecret(user.mfa_secret), code)) throw new Error('MFA_CODE_INVALID');
  db.run('UPDATE users SET mfa_enabled=1 WHERE id=?', userId);
  return { enabled: true };
}

export function verifyMfa(db, userId, code) {
  const user = db.get('SELECT mfa_secret,mfa_enabled FROM users WHERE id=?', userId);
  if (!user?.mfa_enabled) return false;
  if (user.mfa_secret && verifyTotpSecret(decryptSecret(user.mfa_secret), code)) return true;
  return consumeRecoveryCode(db, userId, code);
}

function verifyTotpSecret(secret, code) {
  const current = Math.floor(Date.now() / 30000);
  return [-1, 0, 1].some((offset) => totp(secret, current + offset) === String(code));
}

export function consumeQuota(db, tenantId, { tokens = 0, runs = 0, costUsd = 0 } = {}) {
  if (tokens < 0 || runs < 0 || costUsd < 0) throw new Error('INVALID_QUOTA_DELTA');
  const period = new Date().toISOString().slice(0, 7);
  // The read-check-write must be atomic: two concurrent requests could otherwise
  // both observe the same remaining quota and both pass the limit check, letting a
  // tenant exceed its plan. BEGIN IMMEDIATE (via db.transaction) takes the write
  // lock up front so the check and the increment happen under one serialized lock.
  return db.transaction(() => {
    const quota = db.get('SELECT monthly_tokens,monthly_runs,monthly_cost_usd FROM usage_quotas WHERE tenant_id=?', tenantId) ?? { monthly_tokens: 100000, monthly_runs: 1000, monthly_cost_usd: 10 };
    const current = db.get('SELECT tokens,runs,cost_usd FROM usage_counters WHERE tenant_id=? AND period=?', tenantId, period) ?? { tokens: 0, runs: 0, cost_usd: 0 };
    if (current.tokens + tokens > quota.monthly_tokens) throw new Error('MONTHLY_TOKEN_QUOTA_EXCEEDED');
    if (current.runs + runs > quota.monthly_runs) throw new Error('MONTHLY_RUN_QUOTA_EXCEEDED');
    // Spending limit: a positive cap is enforced; 0 or null means "no cap" so a
    // tenant can be configured for unlimited spend without a schema change.
    const cap = Number(quota.monthly_cost_usd) || 0;
    if (cap > 0 && current.cost_usd + costUsd > cap) throw new Error('MONTHLY_COST_QUOTA_EXCEEDED');
    db.run('INSERT INTO usage_counters(tenant_id,period,tokens,runs,cost_usd,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,period) DO UPDATE SET tokens=tokens+excluded.tokens,runs=runs+excluded.runs,cost_usd=cost_usd+excluded.cost_usd,updated_at=excluded.updated_at', tenantId, period, tokens, runs, costUsd, now());
    return { period, tokens: current.tokens + tokens, runs: current.runs + runs, costUsd: Number((current.cost_usd + costUsd).toFixed(6)), limits: quota };
  });
}
