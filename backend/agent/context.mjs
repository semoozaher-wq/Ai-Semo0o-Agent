// =============================================================================
// backend/agent/context.mjs
// -----------------------------------------------------------------------------
// The Maestro "Context Compiler".
//
// It assembles the bounded, trusted execution context a run needs (goal,
// workspace, tenant self-improvement hints/notes) and, crucially, it neutralises
// UNTRUSTED text before it is ever fed back to a model. Tool results, scraped
// pages and document extracts are attacker-influenced data: they must never be
// able to impersonate a system/developer message or hijack the planner.
//
// Nothing here is a new execution path — it only produces the strings the
// existing Maestro loop (`backend/agent/runtime.mjs`) already consumes, so the
// loop keeps its single responsibility while gaining a single, auditable place
// to sanitise untrusted content.
//
// The hardening is intentionally incremental: every step is a small, local,
// testable transform (strip invisible/control characters -> neutralise known
// injection phrases -> defuse role-spoofing lines -> bound the number of lines
// -> bound the total size). No new subsystem is introduced.
// =============================================================================

/**
 * High-signal prompt-injection patterns. These are intentionally conservative:
 * they neutralise the classic "ignore previous instructions" / role-spoofing /
 * safety-bypass attacks without mangling ordinary prose.
 */
const INJECTION_PATTERNS = Object.freeze([
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|following)\s+instructions?\b/gi,
  /\bignore\s+(?:the\s+)?(?:above|following|rest)\b/gi,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|instructions?|rules?)\b/gi,
  /\bforget\s+(?:everything|all|your)\b/gi,
  /\byou\s+are\s+now\b/gi,
  /\bnew\s+(?:system\s+)?instructions?\s*:/gi,
  /\boverride\s+(?:your|the|all)\s+(?:instructions?|rules?|policy|policies|guidelines?)\b/gi,
  /\b(?:bypass|circumvent|disable|ignore)\s+(?:the\s+)?(?:safety|security|guardrails?|filters?|restrictions?|protections?)\b/gi,
  /\b(?:jailbreak|developer\s+mode|dan\s+mode|do\s+anything\s+now)\b/gi,
  /\b(?:act|behave)\s+as\s+(?:if\s+you\s+(?:are|were)\s+)?(?:a\s+|an\s+|the\s+)?(?:system|admin|administrator|root|developer|assistant|ai|superuser)\b/gi,
  /<\|?\s*(?:system|assistant|developer|user|tool)\s*\|?>/gi,
  /<\|(?:im_start|im_end|endoftext|start_header_id|end_header_id)\|>/gi,
  /\b(?:reveal|print|show|leak|repeat|output|echo)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions?)\b/gi,
  /\byour\s+(?:real\s+|true\s+|actual\s+)?(?:system\s+)?(?:prompt|instructions?)\s+(?:is|are)\b/gi,
  /\b(?:execute|run)\s+the\s+following\s+(?:code|command)\b/gi,
]);

/** Lines that look like a chat role marker are prefixed so they read as data. */
const ROLE_LINE = /^\s*(?:system|assistant|developer|tool|user|function)\s*:/i;

/**
 * Characters that have no legitimate place in model input:
 *   - C0/C1 control characters (except \n and \t, handled separately)
 *   - zero-width and bidirectional-override characters, which attackers use to
 *     hide injected instructions from a human reviewer.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_HINT_CHARS = 500;
const DEFAULT_MAX_HINTS = 50;
const DEFAULT_MAX_GUIDANCE_CHARS = 4_000;
const DEFAULT_MAX_GOAL_CHARS = 4_000;

/** Strip control/invisible characters while preserving newlines and tabs. */
function stripInvisible(text) {
  return text.replace(CONTROL_CHARS, '').replace(INVISIBLE_CHARS, '');
}

/**
 * Bound a string by keeping a head and a tail (so both the start of a document
 * and its conclusion survive) instead of only the head. Very small limits fall
 * back to a simple head truncation.
 */
function truncate(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 32) return `${text.slice(0, maxChars)}\n[truncated]`;
  const budget = maxChars - 20;
  const head = Math.ceil(budget * 0.6);
  const tail = Math.max(0, budget - head);
  return `${text.slice(0, head)}\n[...truncated...]\n${text.slice(text.length - tail)}`;
}

/**
 * Neutralise a single untrusted string. Non-strings are returned untouched so
 * callers can pass them straight through `sanitizeDeep`.
 */
export function sanitizeUntrusted(value, { maxChars = DEFAULT_MAX_CHARS, maxLines = DEFAULT_MAX_LINES } = {}) {
  if (typeof value !== 'string') return value;
  if (!value) return value;
  let text = stripInvisible(value);
  for (const pattern of INJECTION_PATTERNS) text = text.replace(pattern, '[redacted-instruction]');
  let lines = text
    .split('\n')
    .map((line) => (ROLE_LINE.test(line) ? `[untrusted-data] ${line.replace(/^\s*([a-z]+)\s*:/i, '$1 -')}` : line));
  if (Number.isFinite(maxLines) && maxLines > 0 && lines.length > maxLines) {
    lines = [...lines.slice(0, maxLines), '[...truncated...]'];
  }
  text = lines.join('\n');
  return truncate(text, Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_CHARS);
}

/**
 * Recursively sanitise every string leaf of a value (arrays/objects included).
 * Used before serialising tool results into a model prompt.
 */
export function sanitizeDeep(value, options) {
  if (typeof value === 'string') return sanitizeUntrusted(value, options);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, options));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitizeDeep(item, options);
    return out;
  }
  return value;
}

/**
 * Bound and sanitise a single hint/note line: collapse it to one line, strip
 * invisible characters, defuse any injection phrase and cap its length.
 */
function boundLine(value, maxChars = DEFAULT_MAX_HINT_CHARS) {
  const text = stripInvisible(String(value ?? '')).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return sanitizeUntrusted(text, { maxChars, maxLines: 1 });
}

/** Bound a list of hint/note lines (count + per-line length). */
function boundList(values, { maxItems = DEFAULT_MAX_HINTS, maxChars = DEFAULT_MAX_HINT_CHARS } = {}) {
  if (!Array.isArray(values)) return [];
  return values
    .slice(0, maxItems)
    .map((line) => boundLine(line, maxChars))
    .filter(Boolean);
}

/**
 * Compile the trusted run context. Pure and side-effect free so it is trivial to
 * unit test and safe to call on every run. The goal and the tenant self-improvement
 * hints/notes are bounded and sanitised here so a hostile tenant cannot smuggle an
 * oversized or injected guidance block into the planner prompt.
 */
export function compileRunContext({ task, workspace, payload = {}, overrides = {} } = {}) {
  const goal = boundLine(task?.goal ?? payload.goal ?? '', DEFAULT_MAX_GOAL_CHARS);
  const hints = boundList(overrides.plannerHints);
  const notes = boundList(overrides.knowledgeNotes);
  const workspaceRoot = workspace?.root_path || process.env.WORKSPACE_ROOT || null;
  return { goal, hints, notes, workspaceRoot };
}

/**
 * Render the "Learned guidance" block the planner prompt appends. Kept here so
 * the guidance format has exactly one definition, and bounded so the block can
 * never dominate the prompt.
 */
export function renderGuidance({ hints = [], notes = [] } = {}) {
  const text = [...hints, ...notes]
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join('\n');
  return truncate(text, DEFAULT_MAX_GUIDANCE_CHARS);
}
