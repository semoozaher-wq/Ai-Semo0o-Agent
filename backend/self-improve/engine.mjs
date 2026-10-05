import { TOOL_BY_ID } from '../agent/catalog.mjs';
import { classifyError, SEVERITY_BY_CATEGORY, validatePatch } from './policy.mjs';
import {
  createProposal, deactivateOverrides, findOpenProposal, getProposal, listProposals,
  recordEvent, setProposalStatus, writeOverride,
} from './store.mjs';

// ===========================================================================
// Self-improvement / self-healing engine.
//
//   detect  -> read this tenant's own run outcomes and cluster failures
//   analyze -> classify each cluster into a deterministic root cause
//   plan    -> map the cause to a bounded, reversible remediation patch
//   verify  -> re-validate the patch against the safety policy
//   deploy  -> apply the override (human approval required for every change)
//   monitor -> watch for recurrence of the original failure signature
//   rollback-> revert the override automatically on regression
//
// The engine only ever reads run/event/tool-call telemetry for its own tenant and
// only ever writes to self_improve_* tables. It cannot touch auth, permissions,
// billing, or tenant isolation.
// ===========================================================================

const DEFAULT_WINDOW_HOURS = 168; // 7 days
const DEFAULT_MIN_OCCURRENCES = 2;

/** Cluster this tenant's recent failures into ranked signals. */
export function detectSignals(db, { tenantId, since, windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const sinceIso = since || new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const signals = new Map();
  const bump = (signature, category, sample) => {
    const entry = signals.get(signature) || { signature, category, occurrences: 0, samples: [] };
    entry.occurrences += 1;
    if (entry.samples.length < 5) entry.samples.push(sample);
    signals.set(signature, entry);
  };

  const toolFailures = db.all(
    `SELECT tc.tool_id AS tool_id, tc.output_json AS output_json, tc.created_at AS created_at, tc.run_id AS run_id
       FROM tool_calls tc JOIN runs r ON r.id = tc.run_id
      WHERE r.tenant_id = ? AND tc.status = 'failed' AND tc.created_at >= ?`,
    tenantId, sinceIso,
  );
  for (const row of toolFailures) {
    let error = '';
    try { error = JSON.parse(row.output_json || '{}').error || ''; } catch { /* keep empty */ }
    const category = classifyError(error);
    bump(`${category}:${row.tool_id}`, category, { toolId: row.tool_id, error: String(error).slice(0, 300), runId: row.run_id, at: row.created_at });
  }

  const planFailures = db.all(
    `SELECT e.payload_json AS payload_json, e.created_at AS created_at, e.run_id AS run_id
       FROM run_events e JOIN runs r ON r.id = e.run_id
      WHERE r.tenant_id = ? AND e.type = 'planning_failed' AND e.created_at >= ?`,
    tenantId, sinceIso,
  );
  for (const row of planFailures) {
    let error = '';
    try { error = JSON.parse(row.payload_json || '{}').error || ''; } catch { /* keep empty */ }
    const category = classifyError(error);
    bump(`${category}:planner`, category, { error: String(error).slice(0, 300), runId: row.run_id, at: row.created_at });
  }

  const failedRuns = db.all(
    `SELECT id, result_json, updated_at FROM runs
      WHERE tenant_id = ? AND status IN ('failed','unverified') AND updated_at >= ?`,
    tenantId, sinceIso,
  );
  for (const row of failedRuns) {
    let error = '';
    try { error = JSON.parse(row.result_json || '{}').error || ''; } catch { /* keep empty */ }
    if (!error) continue;
    const category = classifyError(error);
    bump(`${category}:run`, category, { error: String(error).slice(0, 300), runId: row.id, at: row.updated_at });
  }

  return [...signals.values()].sort((a, b) => b.occurrences - a.occurrences);
}

/** Map a diagnosed signal to a bounded remediation, or null when none is safe. */
export function planRemediation(signal) {
  const toolId = signal.samples.find((sample) => sample.toolId)?.toolId;
  switch (signal.category) {
    case 'connector_unconfigured':
      if (!toolId) return null;
      return {
        title: `Stop planning unconfigured tool ${toolId}`,
        rationale: 'The planner keeps selecting a tool whose connector is not configured server-side, wasting steps and producing failed runs. Disabling it in the planner is fail-closed and fully reversible.',
        patch: { kind: 'tool_disable', toolId, reason: 'connector not configured' },
      };
    case 'planner_unknown_tool':
      return {
        title: 'Constrain the planner to the exact allowed tool IDs',
        rationale: 'Plans referenced tool IDs outside the allowed list. A strict planner hint prevents invented tool names.',
        patch: { kind: 'planner_hint', text: 'Only choose tool IDs from the exact allowed list provided. Never invent, abbreviate, or rename a tool.' },
      };
    case 'planner_invalid':
      return {
        title: 'Strengthen planner JSON contract',
        rationale: 'The planner returned malformed JSON. A stricter output contract reduces invalid plans.',
        patch: { kind: 'planner_hint', text: 'Always return a single JSON object with a "steps" array. Each step must include id, title, toolId, and an args object.' },
      };
    case 'loop_detected':
      return {
        title: 'Discourage repeated identical tool calls',
        rationale: 'The agent repeated an identical tool call. Guiding the planner to vary the approach prevents loops.',
        patch: { kind: 'planner_hint', text: 'Never repeat an identical tool call with identical arguments. Change the approach or produce the final answer.' },
      };
    case 'timeout':
      return {
        title: 'Raise the agent time budget within safe bounds',
        rationale: 'Runs are hitting the time limit. A bounded increase gives legitimate long tasks room without removing the cap.',
        patch: { kind: 'limit_adjust', field: 'timeoutMs', value: 900_000 },
      };
    case 'limit_exceeded':
      return {
        title: 'Raise the tool-call budget within safe bounds',
        rationale: 'Runs are hitting the tool-call limit. A bounded increase supports multi-step tasks while staying capped.',
        patch: { kind: 'limit_adjust', field: 'maxToolCalls', value: 32 },
      };
    case 'path_guard':
      return {
        title: 'Teach the planner workspace path rules',
        rationale: 'File tools rejected a path outside the workspace. A knowledge note keeps the planner inside the sandbox.',
        patch: { kind: 'knowledge_note', text: 'File tools accept only paths relative to the project workspace. Never use absolute paths, drive letters, or "..".' },
      };
    case 'scrape_failure':
      return {
        title: 'Add bounded retries for web scraping',
        rationale: 'Web scraping failed transiently. A bounded retry policy improves resilience without masking permanent errors.',
        patch: { kind: 'retry_policy', toolId: toolId || 'web.scrape', maxRetries: 3 },
      };
    case 'tool_failure':
      if (!toolId) return null;
      return {
        title: `Add bounded retries for ${toolId}`,
        rationale: `${toolId} failed repeatedly. A bounded retry policy improves resilience while preserving the failure surface.`,
        patch: { kind: 'retry_policy', toolId, maxRetries: 3 },
      };
    default:
      return null;
  }
}

function regressionArtifact(signal, windowHours) {
  return {
    signature: signal.signature,
    expect: 'no_recurrence',
    threshold: 1,
    windowHours,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Full analyze pass: detect signals, plan remediations, and (optionally) store
 * proposals for human review. Returns the signals plus any proposals created.
 */
export function analyze(db, { tenantId, windowHours = DEFAULT_WINDOW_HOURS, minOccurrences = DEFAULT_MIN_OCCURRENCES, autoCreate = true, createdBy = 'engine' } = {}) {
  const signals = detectSignals(db, { tenantId, windowHours });
  const created = [];
  for (const signal of signals) {
    if (signal.occurrences < minOccurrences) continue;
    const plan = planRemediation(signal);
    if (!plan) continue;
    let patch;
    try { patch = validatePatch(plan.patch); } catch { continue; }
    if (autoCreate) {
      const existing = findOpenProposal(db, tenantId, signal.signature, patch.kind);
      if (existing) { created.push({ ...existing, deduplicated: true }); continue; }
      const proposal = createProposal(db, {
        tenantId, signature: signal.signature, category: signal.category,
        severity: SEVERITY_BY_CATEGORY[signal.category] || 'low',
        title: plan.title, rationale: plan.rationale, patch,
        evidence: { occurrences: signal.occurrences, windowHours, samples: signal.samples },
        regression: regressionArtifact(signal, windowHours), createdBy,
      });
      created.push(proposal);
    } else {
      created.push({ signature: signal.signature, category: signal.category, severity: SEVERITY_BY_CATEGORY[signal.category] || 'low', title: plan.title, rationale: plan.rationale, patch, occurrences: signal.occurrences });
    }
  }
  recordEvent(db, { tenantId, phase: 'detect', detail: { signals: signals.length, proposals: created.length, windowHours } });
  return { signals, proposals: created };
}

/** Re-validate a stored proposal against the safety policy before it can apply. */
export function verifyProposal(db, tenantId, proposalId) {
  const proposal = getProposal(db, tenantId, proposalId);
  if (!proposal) throw new Error('SELF_IMPROVE_PROPOSAL_NOT_FOUND');
  const checks = [];
  validatePatch(proposal.patch);
  checks.push({ name: 'policy', ok: true });
  if (proposal.patch.kind === 'tool_disable') {
    const known = TOOL_BY_ID.has(proposal.patch.toolId);
    checks.push({ name: 'known_tool', ok: known, toolId: proposal.patch.toolId });
    if (!known) throw new Error(`SELF_IMPROVE_UNKNOWN_TOOL:${proposal.patch.toolId}`);
  }
  const ok = checks.every((check) => check.ok);
  recordEvent(db, { tenantId, proposalId, phase: 'verify', detail: { ok, checks } });
  return { ok, checks, proposal };
}

/** Apply a proposal: write the override and mark it applied. Requires approval. */
export function applyProposal(db, { tenantId, proposalId, decidedBy }) {
  const proposal = getProposal(db, tenantId, proposalId);
  if (!proposal) throw new Error('SELF_IMPROVE_PROPOSAL_NOT_FOUND');
  if (proposal.status === 'applied') return proposal;
  if (proposal.status !== 'proposed') throw new Error(`SELF_IMPROVE_INVALID_TRANSITION:${proposal.status}`);
  verifyProposal(db, tenantId, proposalId);
  db.transaction(() => {
    writeOverride(db, tenantId, proposalId, proposal.patch, { scope: proposal.scope });
    setProposalStatus(db, tenantId, proposalId, 'applied', { decidedBy, appliedAt: new Date().toISOString() });
  });
  recordEvent(db, { tenantId, proposalId, phase: 'deploy', detail: { kind: proposal.patch.kind, by: decidedBy } });
  return getProposal(db, tenantId, proposalId);
}

export function rejectProposal(db, { tenantId, proposalId, decidedBy, reason = '' }) {
  const proposal = getProposal(db, tenantId, proposalId);
  if (!proposal) throw new Error('SELF_IMPROVE_PROPOSAL_NOT_FOUND');
  if (proposal.status !== 'proposed') throw new Error(`SELF_IMPROVE_INVALID_TRANSITION:${proposal.status}`);
  setProposalStatus(db, tenantId, proposalId, 'rejected', { decidedBy });
  recordEvent(db, { tenantId, proposalId, phase: 'reject', detail: { by: decidedBy, reason: String(reason).slice(0, 500) } });
  return getProposal(db, tenantId, proposalId);
}

/** Roll back an applied proposal: deactivate its override. */
export function rollbackProposal(db, { tenantId, proposalId, decidedBy, reason = 'manual rollback', auto = false }) {
  const proposal = getProposal(db, tenantId, proposalId);
  if (!proposal) throw new Error('SELF_IMPROVE_PROPOSAL_NOT_FOUND');
  if (!['applied', 'regressed'].includes(proposal.status)) throw new Error(`SELF_IMPROVE_INVALID_TRANSITION:${proposal.status}`);
  db.transaction(() => {
    deactivateOverrides(db, tenantId, proposalId);
    setProposalStatus(db, tenantId, proposalId, 'rolled_back', { decidedBy, rolledBackAt: new Date().toISOString() });
  });
  recordEvent(db, { tenantId, proposalId, phase: 'rollback', detail: { by: decidedBy, reason, auto } });
  return getProposal(db, tenantId, proposalId);
}

/**
 * Monitor applied proposals for recurrence of their original failure signature.
 * A regression triggers an automatic rollback so a bad self-improvement can never
 * persist. Returns a summary of what was checked and rolled back.
 */
export function monitor(db, { tenantId, windowHours = 24 } = {}) {
  const applied = listProposals(db, tenantId, { status: 'applied' });
  const rolledBack = [];
  const checked = [];
  for (const proposal of applied) {
    const since = proposal.appliedAt || proposal.updatedAt;
    const signals = detectSignals(db, { tenantId, since });
    const recurring = signals.find((signal) => signal.signature === proposal.signature);
    const threshold = proposal.regression?.threshold ?? 1;
    const regressed = Boolean(recurring && recurring.occurrences >= threshold);
    checked.push({ proposalId: proposal.id, signature: proposal.signature, occurrences: recurring?.occurrences ?? 0, regressed });
    if (regressed) {
      const rolled = rollbackProposal(db, { tenantId, proposalId: proposal.id, decidedBy: 'engine', reason: `regression: ${recurring.occurrences} recurrence(s) after apply`, auto: true });
      setProposalStatus(db, tenantId, proposal.id, 'regressed');
      rolledBack.push({ ...rolled, status: 'regressed', recurrence: recurring.occurrences });
    }
  }
  recordEvent(db, { tenantId, phase: 'monitor', detail: { checked: checked.length, rolledBack: rolledBack.length } });
  return { checked, rolledBack };
}
