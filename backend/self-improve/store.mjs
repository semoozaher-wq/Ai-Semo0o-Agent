import { id, now } from '../db/client.mjs';
import { overrideTarget, validatePatch } from './policy.mjs';

// ===========================================================================
// Persistence for the self-improvement engine. All reads/writes are tenant
// scoped. Overrides are the ONLY mechanism the engine uses to influence agent
// behaviour, and they are always reversible.
// ===========================================================================

function rowToProposal(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope,
    signature: row.signature,
    category: row.category,
    kind: row.kind,
    status: row.status,
    severity: row.severity,
    title: row.title,
    rationale: row.rationale,
    patch: JSON.parse(row.patch_json),
    evidence: JSON.parse(row.evidence_json),
    regression: row.regression_json ? JSON.parse(row.regression_json) : null,
    occurrences: row.occurrences,
    createdBy: row.created_by,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    rolledBackAt: row.rolled_back_at,
  };
}

export function recordEvent(db, { tenantId, proposalId = null, phase, detail = {} }) {
  db.run(
    'INSERT INTO self_improve_events(id,tenant_id,proposal_id,phase,detail_json,created_at) VALUES(?,?,?,?,?,?)',
    id('sievent'), tenantId, proposalId, phase, JSON.stringify(detail), now(),
  );
  db.run(
    'INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)',
    id('audit'), tenantId, `self_improve.${phase}`, 'self_improve_proposal', proposalId, JSON.stringify(detail), now(),
  );
}

export function findOpenProposal(db, tenantId, signature, kind) {
  return rowToProposal(db.get(
    "SELECT * FROM self_improve_proposals WHERE tenant_id=? AND signature=? AND kind=? AND status IN ('proposed','applied') ORDER BY created_at DESC LIMIT 1",
    tenantId, signature, kind,
  ));
}

export function createProposal(db, { tenantId, scope = 'tenant', signature, category, severity, title, rationale, patch, evidence, regression = null, createdBy = 'engine' }) {
  const normalized = validatePatch(patch);
  const timestamp = now();
  const proposalId = id('siprop');
  db.run(
    `INSERT INTO self_improve_proposals(id,tenant_id,scope,signature,category,kind,status,severity,title,rationale,patch_json,evidence_json,regression_json,occurrences,created_by,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    proposalId, tenantId, scope, signature, category, normalized.kind, 'proposed', severity, title, rationale,
    JSON.stringify(normalized), JSON.stringify(evidence), regression ? JSON.stringify(regression) : null,
    Number(evidence?.occurrences ?? 0), createdBy, timestamp, timestamp,
  );
  recordEvent(db, { tenantId, proposalId, phase: 'plan', detail: { signature, category, kind: normalized.kind, severity } });
  return getProposal(db, tenantId, proposalId);
}

export function getProposal(db, tenantId, proposalId) {
  return rowToProposal(db.get('SELECT * FROM self_improve_proposals WHERE id=? AND tenant_id=?', proposalId, tenantId));
}

export function listProposals(db, tenantId, { status, limit = 50 } = {}) {
  const rows = status
    ? db.all('SELECT * FROM self_improve_proposals WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT ?', tenantId, status, Math.min(200, limit))
    : db.all('SELECT * FROM self_improve_proposals WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?', tenantId, Math.min(200, limit));
  return rows.map(rowToProposal);
}

export function listEvents(db, tenantId, { proposalId, limit = 100 } = {}) {
  const rows = proposalId
    ? db.all('SELECT * FROM self_improve_events WHERE tenant_id=? AND proposal_id=? ORDER BY created_at DESC LIMIT ?', tenantId, proposalId, Math.min(500, limit))
    : db.all('SELECT * FROM self_improve_events WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?', tenantId, Math.min(500, limit));
  return rows.map((row) => ({ id: row.id, proposalId: row.proposal_id, phase: row.phase, detail: JSON.parse(row.detail_json), createdAt: row.created_at }));
}

export function setProposalStatus(db, tenantId, proposalId, status, extra = {}) {
  const timestamp = now();
  const fields = ['status=?', 'updated_at=?'];
  const params = [status, timestamp];
  if (extra.decidedBy !== undefined) { fields.push('decided_by=?'); params.push(extra.decidedBy); }
  if (extra.appliedAt !== undefined) { fields.push('applied_at=?'); params.push(extra.appliedAt); }
  if (extra.rolledBackAt !== undefined) { fields.push('rolled_back_at=?'); params.push(extra.rolledBackAt); }
  params.push(proposalId, tenantId);
  const result = db.run(`UPDATE self_improve_proposals SET ${fields.join(',')} WHERE id=? AND tenant_id=?`, ...params);
  if (result.changes !== 1) throw new Error('SELF_IMPROVE_PROPOSAL_NOT_FOUND');
  return getProposal(db, tenantId, proposalId);
}

/** Write (or reactivate) the override row a patch maps to. */
export function writeOverride(db, tenantId, proposalId, patch, { scope = 'tenant' } = {}) {
  const { kind, target } = overrideTarget(patch);
  const timestamp = now();
  const existing = db.get('SELECT id FROM self_improve_overrides WHERE tenant_id=? AND kind=? AND target=?', tenantId, kind, target);
  if (existing) {
    db.run('UPDATE self_improve_overrides SET value_json=?, proposal_id=?, active=1, updated_at=? WHERE id=?', JSON.stringify(patch), proposalId, timestamp, existing.id);
  } else {
    db.run(
      'INSERT INTO self_improve_overrides(id,tenant_id,scope,kind,target,value_json,proposal_id,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id('siover'), tenantId, scope, kind, target, JSON.stringify(patch), proposalId, 1, timestamp, timestamp,
    );
  }
  return { kind, target };
}

export function deactivateOverrides(db, tenantId, proposalId) {
  return db.run('UPDATE self_improve_overrides SET active=0, updated_at=? WHERE tenant_id=? AND proposal_id=? AND active=1', now(), tenantId, proposalId).changes;
}

/**
 * Load the active override set for a tenant in the shape the agent runtime needs.
 * Pure read; safe to call on every run. Never throws on missing tables (older DBs).
 */
export function loadOverrides(db, tenantId) {
  const result = { disabledTools: new Set(), plannerHints: [], knowledgeNotes: [], retryPolicy: {}, limits: {} };
  if (!tenantId) return result;
  let rows = [];
  try { rows = db.all('SELECT kind,target,value_json FROM self_improve_overrides WHERE tenant_id=? AND active=1', tenantId); }
  catch { return result; }
  for (const row of rows) {
    let value;
    try { value = JSON.parse(row.value_json); } catch { continue; }
    switch (row.kind) {
      case 'tool_disable': result.disabledTools.add(row.target); break;
      case 'planner_hint': result.plannerHints.push(String(value.text || '')); break;
      case 'knowledge_note': result.knowledgeNotes.push(String(value.text || '')); break;
      case 'retry_policy': result.retryPolicy[row.target] = Number(value.maxRetries); break;
      case 'limit_adjust': result.limits[row.target] = Number(value.value); break;
      default: break;
    }
  }
  return result;
}
