// =============================================================================
// backend/agent/recovery.mjs
// -----------------------------------------------------------------------------
// The single recovery contract shared with the frontend orchestrator.
//
// The failure taxonomy, the recovery actions, the event names and the
// classifier table all live in `shared/recovery-contract.json`, which the
// React Native side (`src/services/agent-engine/verification.ts`) imports too.
// This module only adds the tiny bit of logic that cannot live in JSON, so the
// backend and the frontend classify failures and name events identically
// WITHOUT introducing a second recovery architecture.
// =============================================================================
import contract from '../../shared/recovery-contract.json' with { type: 'json' };

export const FAILURE_KINDS = Object.freeze([...contract.failureKinds]);
export const RECOVERY_ACTIONS = Object.freeze([...contract.recoveryActions]);
export const RECOVERY_EVENTS = Object.freeze({ ...contract.events });
export const MAX_RECOVERY_ATTEMPTS = contract.maxAttempts;
const CLASSIFIERS = Object.freeze(contract.classifiers.map((rule) => Object.freeze({ kind: rule.kind, patterns: [...rule.patterns] })));

/**
 * Classify an error into the shared failure taxonomy. The `code` property (when
 * present) is inspected alongside the message, matching the frontend exactly.
 */
export function classifyFailure(error, fallback = 'UNKNOWN_FAILURE') {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const text = `${code} ${message}`.toLowerCase();
  for (const rule of CLASSIFIERS) {
    if (rule.patterns.some((pattern) => text.includes(pattern))) return rule.kind;
  }
  return fallback;
}

/**
 * The bounded recovery policy shared by both sides. It never allows an
 * unbounded loop: a permission failure blocks immediately, everything else is
 * repaired while attempts remain and then replanned (or blocked when replanning
 * is not available).
 */
export function recoveryActionFor({ failureKind = 'UNKNOWN_FAILURE', attempt = 1, maxAttempts = MAX_RECOVERY_ATTEMPTS, canRepair = true, canReplan = true } = {}) {
  if (failureKind === 'PERMISSION_FAILURE') return 'block';
  if (attempt < Math.max(1, Number(maxAttempts) || 1) && canRepair) return 'repair';
  if (canReplan) return 'replan';
  return 'block';
}
