import { id, now } from '../db/client.mjs';

// ===========================================================================
// Organization / membership management.
//
// `tenant_members` is the authoritative roster; `users.role` / `users.tenant_id`
// remain the "home" identity that `authenticateToken` resolves for authorization.
// For a member whose home tenant is this tenant we keep `users.role` in sync so
// the change is actually enforced at the auth layer. Invited members from other
// tenants only carry a `tenant_members` row.
//
// Safety invariants enforced here (never bypassed by the API layer):
//   * A tenant can never be left with zero owners.
//   * Ownership transfer is intentionally NOT exposed through role updates; it
//     requires a dedicated, audited flow so it cannot happen by accident.
// ===========================================================================

const ASSIGNABLE_ROLES = Object.freeze(['admin', 'member', 'viewer']);

function assertTenantMember(db, tenantId, userId) {
  const member = db.get('SELECT * FROM tenant_members WHERE tenant_id=? AND user_id=?', tenantId, userId);
  if (!member) throw new Error('ORG_MEMBER_NOT_FOUND');
  return member;
}

function ownerCount(db, tenantId) {
  return db.get("SELECT COUNT(*) AS n FROM tenant_members WHERE tenant_id=? AND role='owner' AND status='active'", tenantId).n;
}

function assertOwnerRemains(db, tenantId, userId, nextRole) {
  const member = db.get('SELECT role,status FROM tenant_members WHERE tenant_id=? AND user_id=?', tenantId, userId);
  if (!member || member.role !== 'owner' || member.status !== 'active') return;
  if (nextRole === 'owner') return;
  if (ownerCount(db, tenantId) <= 1) throw new Error('ORG_LAST_OWNER_PROTECTED');
}

function audit(db, tenantId, action, resourceId, metadata, actorId) {
  db.run(
    'INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
    id('audit'), tenantId, action, 'membership', resourceId, JSON.stringify({ ...metadata, actorId }), now(),
  );
}

export function listMembers(db, tenantId) {
  return db.all(
    `SELECT tm.user_id AS userId, u.email AS email, tm.role AS role, tm.status AS status, tm.created_at AS joinedAt
       FROM tenant_members tm JOIN users u ON u.id = tm.user_id
      WHERE tm.tenant_id = ?
      ORDER BY tm.created_at ASC`,
    tenantId,
  );
}

export function updateMemberRole(db, { tenantId, userId, role, actorId }) {
  if (!ASSIGNABLE_ROLES.includes(role)) {
    if (role === 'owner') throw new Error('ORG_OWNER_TRANSFER_REQUIRES_DEDICATED_FLOW');
    throw new Error('ORG_ROLE_INVALID');
  }
  assertTenantMember(db, tenantId, userId);
  assertOwnerRemains(db, tenantId, userId, role);
  db.transaction(() => {
    db.run('UPDATE tenant_members SET role=? WHERE tenant_id=? AND user_id=?', role, tenantId, userId);
    // Keep the home identity in sync so authorization reflects the new role.
    db.run('UPDATE users SET role=? WHERE id=? AND tenant_id=?', role, userId, tenantId);
    audit(db, tenantId, 'org.member.role_changed', userId, { role }, actorId);
  });
  return db.get('SELECT user_id AS userId, role, status FROM tenant_members WHERE tenant_id=? AND user_id=?', tenantId, userId);
}

export function removeMember(db, { tenantId, userId, actorId }) {
  assertTenantMember(db, tenantId, userId);
  assertOwnerRemains(db, tenantId, userId, null);
  db.transaction(() => {
    db.run('DELETE FROM tenant_members WHERE tenant_id=? AND user_id=?', tenantId, userId);
    // Revoke active sessions immediately so the removed member loses access.
    db.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now(), userId);
    audit(db, tenantId, 'org.member.removed', userId, {}, actorId);
  });
  return { removed: true, userId };
}

export function listInvitations(db, tenantId) {
  return db.all(
    `SELECT i.id AS invitationId, i.email AS email, i.role AS role, i.expires_at AS expiresAt,
            i.accepted_at AS acceptedAt, i.created_at AS createdAt, u.email AS invitedByEmail
       FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.tenant_id = ?
      ORDER BY i.created_at DESC`,
    tenantId,
  );
}

export function revokeInvitation(db, { tenantId, invitationId, actorId }) {
  const invite = db.get('SELECT * FROM invitations WHERE id=? AND tenant_id=?', invitationId, tenantId);
  if (!invite) throw new Error('ORG_INVITATION_NOT_FOUND');
  if (invite.accepted_at) throw new Error('ORG_INVITATION_ALREADY_ACCEPTED');
  db.transaction(() => {
    db.run('DELETE FROM invitations WHERE id=? AND tenant_id=? AND accepted_at IS NULL', invitationId, tenantId);
    audit(db, tenantId, 'org.invitation.revoked', invitationId, { email: invite.email }, actorId);
  });
  return { revoked: true, invitationId };
}
