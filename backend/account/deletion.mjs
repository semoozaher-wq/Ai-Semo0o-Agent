import { id, now } from '../db/client.mjs';
import { purgeTenant } from '../ops/retention.mjs';

// ===========================================================================
// Account & data deletion (data rights / right to erasure).
//
// Two distinct, explicitly-scoped operations:
//
//   * deleteUserAccount  — a single member leaves. Their personal identity and
//     personal content are erased, but tenant-owned data (projects, runs) is
//     preserved by reassigning project ownership to a surviving member. This is
//     the only deletion a non-owner member may perform, and it is the operation
//     that was previously impossible (non-owners always received 403).
//
//   * deleteTenantAccount — an owner erases the entire tenant and everything it
//     owns. Guarded so a tenant can never be left orphaned: if other active
//     members exist the owner must either transfer ownership first or confirm
//     with `force`.
//
// Both operations run inside one transaction and are FK-safe. Several tables
// reference users with ON DELETE RESTRICT (projects, tasks, messages, approvals,
// invitations), so those referrers are cleared/reassigned explicitly before the
// user row is removed.
// ===========================================================================

function ownerCount(db, tenantId) {
  return db.get("SELECT COUNT(*) AS n FROM tenant_members WHERE tenant_id=? AND role='owner' AND status='active'", tenantId).n;
}

function activeMemberCount(db, tenantId, exceptUserId) {
  return db.get('SELECT COUNT(*) AS n FROM tenant_members WHERE tenant_id=? AND status=? AND user_id<>?', tenantId, 'active', exceptUserId).n;
}

function pickSuccessor(db, tenantId, exceptUserId) {
  return db.get(
    `SELECT user_id FROM tenant_members
      WHERE tenant_id=? AND status='active' AND user_id<>?
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at ASC
      LIMIT 1`,
    tenantId, exceptUserId,
  );
}

/**
 * Erase a single user's account and personal data, preserving tenant-owned data.
 * Returns `{ scope, deleted, counts }`. When the user is the last remaining member
 * of the tenant the whole tenant is purged (nothing else is left to preserve) and
 * the result reports `scope: 'tenant'`.
 */
export function deleteUserAccount(db, { tenantId, userId, transferOwnershipTo = null }) {
  const user = db.get('SELECT id,tenant_id,role,email FROM users WHERE id=? AND tenant_id=?', userId, tenantId);
  if (!user) throw new Error('ACCOUNT_NOT_FOUND');

  const isOwner = user.role === 'owner';
  const owners = ownerCount(db, tenantId);
  const others = activeMemberCount(db, tenantId, userId);

  // Last owner, but the tenant still has members: never orphan the tenant. The
  // caller must name a successor owner (or use the tenant-scope deletion).
  if (isOwner && owners <= 1 && others > 0) {
    if (!transferOwnershipTo) throw new Error('ORG_OWNER_TRANSFER_REQUIRED');
    const target = db.get("SELECT user_id FROM tenant_members WHERE tenant_id=? AND user_id=? AND status='active'", tenantId, transferOwnershipTo);
    if (!target || target.user_id === userId) throw new Error('ORG_TRANSFER_TARGET_INVALID');
  }

  // Sole member: deleting the account empties the tenant, so purge it entirely.
  if (isOwner && owners <= 1 && others === 0) {
    return { scope: 'tenant', deleted: true, purged: purgeTenant(db, tenantId) };
  }

  return db.transaction(() => {
    const counts = {};
    const del = (label, sql, ...params) => { counts[label] = db.run(sql, ...params).changes; };

    if (isOwner && transferOwnershipTo) {
      db.run("UPDATE tenant_members SET role='owner' WHERE tenant_id=? AND user_id=?", tenantId, transferOwnershipTo);
      // Keep the home identity in sync only when the target belongs to this tenant.
      db.run("UPDATE users SET role='owner' WHERE id=? AND tenant_id=?", transferOwnershipTo, tenantId);
      counts.ownershipTransferred = 1;
    }

    // Reassign projects owned by the departing user so tenant data survives.
    const successor = pickSuccessor(db, tenantId, userId);
    if (successor) {
      counts.projectsReassigned = db.run('UPDATE projects SET owner_id=? WHERE tenant_id=? AND owner_id=?', successor.user_id, tenantId, userId).changes;
    } else {
      del('projects', 'DELETE FROM projects WHERE tenant_id=? AND owner_id=?', tenantId, userId);
    }

    // Personal content and RESTRICT referrers.
    del('messages', 'DELETE FROM messages WHERE tenant_id=? AND user_id=?', tenantId, userId);
    del('invitations', 'DELETE FROM invitations WHERE tenant_id=? AND invited_by=?', tenantId, userId);
    del('approvals', 'DELETE FROM approvals WHERE requested_by=?', userId);
    del('tasks', 'DELETE FROM tasks WHERE tenant_id=? AND created_by=?', tenantId, userId);

    // Identity artifacts.
    del('sessions', 'DELETE FROM sessions WHERE user_id=?', userId);
    del('account_tokens', 'DELETE FROM account_tokens WHERE user_id=?', userId);
    del('recovery_codes', 'DELETE FROM recovery_codes WHERE user_id=?', userId);
    del('permissions', 'DELETE FROM permissions WHERE user_id=?', userId);
    del('tenant_members', 'DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?', tenantId, userId);
    del('users', 'DELETE FROM users WHERE id=? AND tenant_id=?', userId, tenantId);

    return { scope: 'self', deleted: true, counts };
  });
}

/**
 * Owner-initiated, tenant-wide erasure. Refuses to delete a tenant that still has
 * other active members unless `force` is set, so an owner cannot accidentally
 * destroy teammates' data.
 */
export function deleteTenantAccount(db, { tenantId, userId, force = false }) {
  const user = db.get('SELECT id,role FROM users WHERE id=? AND tenant_id=?', userId, tenantId);
  if (!user) throw new Error('ACCOUNT_NOT_FOUND');
  if (user.role !== 'owner') throw new Error('FORBIDDEN');
  const others = activeMemberCount(db, tenantId, userId);
  if (others > 0 && !force) throw new Error('ORG_TENANT_HAS_OTHER_MEMBERS');
  return { scope: 'tenant', deleted: true, purged: purgeTenant(db, tenantId) };
}
