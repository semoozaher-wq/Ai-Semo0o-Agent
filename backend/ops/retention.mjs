import { now } from '../db/client.mjs';

// ===========================================================================
// Data rights & retention.
//
// `purgeTenant` performs a complete, FK-safe erasure of a tenant and everything
// it owns. Several tables reference users with ON DELETE RESTRICT (projects,
// tasks, messages, approvals, invitations); a naive `DELETE FROM tenants` can
// therefore fail depending on SQLite's cascade ordering. We delete the RESTRICT
// referrers explicitly, in dependency order, inside one transaction.
//
// `runRetention` prunes operational rows that have aged past their retention
// window (expired sessions/tokens/invitations, old run events, audit logs, sent
// mail). It never touches live account data.
// ===========================================================================

export const RETENTION_DEFAULTS = Object.freeze({
  runEventsDays: 30,
  auditLogsDays: 180,
  sentEmailDays: 90,
  failedEmailDays: 90,
  selfImproveEventsDays: 180,
  revokedSessionDays: 30,
  invitationGraceDays: 30,
});

function daysAgoIso(days, reference) {
  return new Date(reference.getTime() - days * 86_400_000).toISOString();
}

export function purgeTenant(db, tenantId) {
  return db.transaction(() => {
    const counts = {};
    const del = (label, sql, ...params) => { counts[label] = db.run(sql, ...params).changes; };
    // Runs subtree first (clears approvals.requested_by RESTRICT before users go).
    del('approvals', 'DELETE FROM approvals WHERE run_id IN (SELECT id FROM runs WHERE tenant_id=?)', tenantId);
    del('run_usage', 'DELETE FROM run_usage WHERE tenant_id=?', tenantId);
    del('run_events', 'DELETE FROM run_events WHERE tenant_id=?', tenantId);
    del('evidence', 'DELETE FROM evidence WHERE run_id IN (SELECT id FROM runs WHERE tenant_id=?)', tenantId);
    del('artifacts', 'DELETE FROM artifacts WHERE run_id IN (SELECT id FROM runs WHERE tenant_id=?)', tenantId);
    del('steps', 'DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE tenant_id=?)', tenantId);
    del('tool_calls', 'DELETE FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE tenant_id=?)', tenantId);
    del('runs', 'DELETE FROM runs WHERE tenant_id=?', tenantId);
    del('tasks', 'DELETE FROM tasks WHERE tenant_id=?', tenantId);
    del('messages', 'DELETE FROM messages WHERE tenant_id=?', tenantId);
    del('chat_messages', 'DELETE FROM chat_messages WHERE tenant_id=?', tenantId);
    del('conversations', 'DELETE FROM conversations WHERE tenant_id=?', tenantId);
    del('embeddings', 'DELETE FROM embeddings WHERE document_id IN (SELECT id FROM documents WHERE tenant_id=?)', tenantId);
    del('documents', 'DELETE FROM documents WHERE tenant_id=?', tenantId);
    del('workspaces', 'DELETE FROM workspaces WHERE project_id IN (SELECT id FROM projects WHERE tenant_id=?)', tenantId);
    del('projects', 'DELETE FROM projects WHERE tenant_id=?', tenantId);
    del('permissions', 'DELETE FROM permissions WHERE tenant_id=?', tenantId);
    del('invitations', 'DELETE FROM invitations WHERE tenant_id=?', tenantId);
    del('account_tokens', 'DELETE FROM account_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id=?)', tenantId);
    del('recovery_codes', 'DELETE FROM recovery_codes WHERE user_id IN (SELECT id FROM users WHERE tenant_id=?)', tenantId);
    del('sessions', 'DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id=?)', tenantId);
    del('tenant_members', 'DELETE FROM tenant_members WHERE tenant_id=?', tenantId);
    del('email_outbox', 'DELETE FROM email_outbox WHERE tenant_id=?', tenantId);
    del('self_improve_overrides', 'DELETE FROM self_improve_overrides WHERE tenant_id=?', tenantId);
    del('self_improve_proposals', 'DELETE FROM self_improve_proposals WHERE tenant_id=?', tenantId);
    del('self_improve_events', 'DELETE FROM self_improve_events WHERE tenant_id=?', tenantId);
    del('audit_logs', 'DELETE FROM audit_logs WHERE tenant_id=?', tenantId);
    del('users', 'DELETE FROM users WHERE tenant_id=?', tenantId);
    del('usage_counters', 'DELETE FROM usage_counters WHERE tenant_id=?', tenantId);
    del('usage_quotas', 'DELETE FROM usage_quotas WHERE tenant_id=?', tenantId);
    del('subscriptions', 'DELETE FROM subscriptions WHERE tenant_id=?', tenantId);
    del('tenants', 'DELETE FROM tenants WHERE id=?', tenantId);
    return counts;
  });
}

export function runRetention(db, { now: nowFn = () => new Date(), policy = RETENTION_DEFAULTS } = {}) {
  const reference = nowFn();
  const iso = reference.toISOString();
  const runEventsBefore = daysAgoIso(policy.runEventsDays, reference);
  const auditBefore = daysAgoIso(policy.auditLogsDays, reference);
  const sentBefore = daysAgoIso(policy.sentEmailDays, reference);
  const failedBefore = daysAgoIso(policy.failedEmailDays, reference);
  const selfImproveBefore = daysAgoIso(policy.selfImproveEventsDays, reference);
  const revokedBefore = daysAgoIso(policy.revokedSessionDays, reference);
  const invitationBefore = daysAgoIso(policy.invitationGraceDays, reference);
  return db.transaction(() => {
    const counts = {};
    const del = (label, sql, ...params) => { counts[label] = db.run(sql, ...params).changes; };
    del('expiredSessions', 'DELETE FROM sessions WHERE (expires_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?)', iso, revokedBefore);
    del('expiredAccountTokens', 'DELETE FROM account_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)', iso, revokedBefore);
    del('expiredInvitations', 'DELETE FROM invitations WHERE (expires_at < ?) OR (accepted_at IS NOT NULL AND accepted_at < ?)', invitationBefore, invitationBefore);
    del('runEvents', 'DELETE FROM run_events WHERE created_at < ?', runEventsBefore);
    del('auditLogs', 'DELETE FROM audit_logs WHERE created_at < ?', auditBefore);
    del('sentEmails', "DELETE FROM email_outbox WHERE status='sent' AND created_at < ?", sentBefore);
    del('failedEmails', "DELETE FROM email_outbox WHERE status='failed' AND created_at < ?", failedBefore);
    del('selfImproveEvents', 'DELETE FROM self_improve_events WHERE created_at < ?', selfImproveBefore);
    return { ranAt: iso, policy, counts };
  });
}
