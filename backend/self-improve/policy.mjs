// ===========================================================================
// Self-improvement policy — the hard safety boundary of the self-healing loop.
//
// The engine is allowed to propose ONLY bounded, reversible, non-security
// remediations. Every proposal is validated against this module before it can be
// stored, applied, or executed. A patch that touches authentication,
// authorization, permissions, billing, tenant isolation, secrets, or the
// sandbox is rejected outright — the engine can never widen its own authority.
// ===========================================================================

export const PROPOSAL_KINDS = Object.freeze(['tool_disable', 'planner_hint', 'retry_policy', 'limit_adjust', 'knowledge_note']);

// Substrings that must never appear in any generated patch. If a planner or a
// model ever tries to smuggle one of these into a remediation, validation fails
// closed. This is intentionally conservative: false positives only block a
// self-improvement, never weaken the platform.
export const FORBIDDEN_PATCH_TOKENS = Object.freeze([
  'password', 'password_hash', 'secret', 'secrets_master_key', 'api_key', 'apikey',
  'token_hash', 'session', 'authenticate', 'authorization', 'permission', 'role',
  'tenant_id', 'tenantid', 'billing', 'subscription', 'quota', 'mfa', 'recovery_code',
  // The `eval` entry below is a forbidden-token *string literal* (data this list
  // blocks), not a call, so it is explicitly exempted from the SAST eval rule.
  'sandbox', 'docker', 'eval(', 'child_process', 'require(', 'import ', // security-scan:allow eval
]);

// Bounded numeric ranges the engine may move within. Anything outside is clamped
// or rejected — the engine cannot, for example, raise a timeout to infinity.
export const SAFE_BOUNDS = Object.freeze({
  maxRetries: { min: 1, max: 5 },
  timeoutMs: { min: 60_000, max: 1_800_000 },
  maxToolCalls: { min: 4, max: 48 },
  maxSteps: { min: 1, max: 12 },
});

const MAX_HINT_LENGTH = 600;
const MAX_NOTE_LENGTH = 2000;

function scanForbidden(value, path = 'patch') {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase();
    for (const token of FORBIDDEN_PATCH_TOKENS) {
      if (lowered.includes(token)) throw new Error(`SELF_IMPROVE_FORBIDDEN_TOKEN:${path}:${token}`);
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((item, index) => scanForbidden(item, `${path}[${index}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) scanForbidden(item, `${path}.${key}`);
  }
}

function assertIntegerInBounds(value, field) {
  const bounds = SAFE_BOUNDS[field];
  if (!bounds) throw new Error(`SELF_IMPROVE_UNKNOWN_FIELD:${field}`);
  if (!Number.isInteger(value)) throw new Error(`SELF_IMPROVE_NOT_INTEGER:${field}`);
  if (value < bounds.min || value > bounds.max) throw new Error(`SELF_IMPROVE_OUT_OF_BOUNDS:${field}`);
  return value;
}

/**
 * Validate and normalize a remediation patch. Returns a frozen, canonical patch
 * or throws. Never mutates the input.
 */
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('SELF_IMPROVE_PATCH_INVALID');
  const kind = patch.kind;
  if (!PROPOSAL_KINDS.includes(kind)) throw new Error(`SELF_IMPROVE_KIND_INVALID:${kind}`);
  scanForbidden(patch);
  switch (kind) {
    case 'tool_disable': {
      if (typeof patch.toolId !== 'string' || !/^[a-z][a-z0-9._-]{1,60}$/i.test(patch.toolId)) throw new Error('SELF_IMPROVE_TOOL_ID_INVALID');
      return Object.freeze({ kind, toolId: patch.toolId, reason: typeof patch.reason === 'string' ? patch.reason.slice(0, MAX_NOTE_LENGTH) : '' });
    }
    case 'planner_hint': {
      if (typeof patch.text !== 'string' || patch.text.trim().length < 8 || patch.text.length > MAX_HINT_LENGTH) throw new Error('SELF_IMPROVE_HINT_INVALID');
      return Object.freeze({ kind, text: patch.text.trim() });
    }
    case 'knowledge_note': {
      if (typeof patch.text !== 'string' || patch.text.trim().length < 8 || patch.text.length > MAX_NOTE_LENGTH) throw new Error('SELF_IMPROVE_NOTE_INVALID');
      return Object.freeze({ kind, text: patch.text.trim() });
    }
    case 'retry_policy': {
      const maxRetries = assertIntegerInBounds(Number(patch.maxRetries), 'maxRetries');
      const toolId = typeof patch.toolId === 'string' && patch.toolId ? patch.toolId : '*';
      return Object.freeze({ kind, toolId, maxRetries });
    }
    case 'limit_adjust': {
      const field = patch.field;
      const value = assertIntegerInBounds(Number(patch.value), field);
      return Object.freeze({ kind, field, value });
    }
    default:
      throw new Error(`SELF_IMPROVE_KIND_INVALID:${kind}`);
  }
}

/** The override target key a patch writes to (used for lookup + rollback). */
export function overrideTarget(patch) {
  switch (patch.kind) {
    case 'tool_disable': return { kind: 'tool_disable', target: patch.toolId };
    case 'planner_hint': return { kind: 'planner_hint', target: 'planner' };
    case 'knowledge_note': return { kind: 'knowledge_note', target: 'planner' };
    case 'retry_policy': return { kind: 'retry_policy', target: patch.toolId };
    case 'limit_adjust': return { kind: 'limit_adjust', target: patch.field };
    default: throw new Error(`SELF_IMPROVE_KIND_INVALID:${patch.kind}`);
  }
}

/**
 * Deterministically classify a raw failure string into a root-cause category.
 * Kept pure so it is unit-testable and cannot be influenced by model output.
 */
export function classifyError(rawError) {
  const text = String(rawError || '').toUpperCase();
  if (text.includes('TOOL_CONNECTOR_NOT_CONFIGURED')) return 'connector_unconfigured';
  if (text.includes('PLANNER_UNKNOWN_TOOL')) return 'planner_unknown_tool';
  if (text.includes('PLANNER_INVALID')) return 'planner_invalid';
  if (text.includes('AGENT_LOOP_DETECTED')) return 'loop_detected';
  if (text.includes('TIME_LIMIT_EXCEEDED') || text.includes('TIMEOUT')) return 'timeout';
  if (text.includes('TOKEN_LIMIT_EXCEEDED') || text.includes('COST_LIMIT_EXCEEDED')) return 'limit_exceeded';
  if (text.includes('PATH_OUTSIDE_WORKSPACE') || text.includes('PATH_OUTSIDE_ROOT')) return 'path_guard';
  if (text.includes('WEB_SCRAPE_HTTP') || text.includes('WEB_SCRAPE_UNSUPPORTED')) return 'scrape_failure';
  if (text.includes('TOOL_FAILED') || text.includes('_OUT_OF_RANGE') || text.includes('CHART_')) return 'tool_failure';
  if (text.includes('NO_HANDLER')) return 'no_handler';
  return 'unknown';
}

export const SEVERITY_BY_CATEGORY = Object.freeze({
  connector_unconfigured: 'medium',
  planner_unknown_tool: 'high',
  planner_invalid: 'high',
  loop_detected: 'high',
  timeout: 'medium',
  limit_exceeded: 'medium',
  path_guard: 'high',
  scrape_failure: 'low',
  tool_failure: 'medium',
  no_handler: 'high',
  unknown: 'low',
});
