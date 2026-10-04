import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { id, now, hash } from '../db/client.mjs';
import { verifyMfa } from './lifecycle.mjs';

const TOKEN_BYTES = 32;
const SESSION_DAYS = 7;
export function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('PASSWORD_POLICY_FAILED');
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}
function verifyPassword(password, encoded) {
  const [, salt, expected] = String(encoded).split('$');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64).toString('hex');
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
export function createUser(db, { email, password, tenantName }) {
  const tenantId = id('tenant');
  const userId = id('user');
  const createdAt = now();
  return db.transaction(() => {
    db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, tenantName || `${email} tenant`, createdAt);
    db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, email.toLowerCase(), passwordHash(password), 'owner', createdAt);
    db.run('INSERT INTO tenant_members(tenant_id,user_id,role,status,created_at) VALUES(?,?,?,?,?)', tenantId, userId, 'owner', 'active', createdAt);
    db.run('INSERT INTO usage_quotas(tenant_id,updated_at) VALUES(?,?)', tenantId, createdAt);
    return db.get('SELECT id,tenant_id,email,role,created_at FROM users WHERE id=?', userId);
  });
}
export function createSession(db, userId) {
  const raw = randomBytes(TOKEN_BYTES).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.run('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)', id('session'), userId, hash(raw), expires, now());
  return { token: raw, expiresAt: expires };
}
export function authenticate(db, email, password, mfaCode) {
  const user = db.get('SELECT * FROM users WHERE lower(email)=lower(?)', email);
  if (!user || !verifyPassword(password, user.password_hash)) throw new Error('INVALID_CREDENTIALS');
  if (user.mfa_enabled) {
    if (typeof mfaCode !== 'string' || !mfaCode) throw new Error('MFA_REQUIRED');
    if (!verifyMfa(db, user.id, mfaCode)) throw new Error('MFA_CODE_INVALID');
  }
  return { user: { id: user.id, tenantId: user.tenant_id, email: user.email, role: user.role }, session: createSession(db, user.id) };
}
export function authenticateToken(db, token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const row = db.get(`SELECT u.id,u.tenant_id,u.email,u.role,s.id AS session_id,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL`, hash(token));
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  return { id: row.id, tenantId: row.tenant_id, email: row.email, role: row.role, sessionId: row.session_id };
}
export function revokeSession(db, sessionId) { db.run('UPDATE sessions SET revoked_at=? WHERE id=?', now(), sessionId); }
export function requireRole(user, roles) { if (!user || !roles.includes(user.role)) throw new Error('FORBIDDEN'); }
export function assertTenant(row, user) { if (!row || !user || row.tenant_id !== user.tenantId) throw new Error('NOT_FOUND'); }
