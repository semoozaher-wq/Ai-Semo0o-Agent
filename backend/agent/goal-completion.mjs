// =============================================================================
// backend/agent/goal-completion.mjs
// -----------------------------------------------------------------------------
// Agent intelligence / goal-completion primitives.
//
// The Maestro loop already plans, executes and (boundedly) recovers. What it did
// NOT have was an explicit, checkable notion of "done": a plan could finish
// without anyone asking whether the GOAL was actually achieved, and the
// recovery decision was an inline `if (replans < maxReplans)`. This module adds
// three small, pure, testable pieces that the runtime consumes:
//
//   1. Success criteria  — `deriveSuccessCriteria` (deterministic fallback) and
//      `normalizeSuccessCriteria` (accepts a model-provided list, bounded).
//   2. Completion check  — `evaluateCompletion` turns the run's real outputs,
//      verification evidence and delivery outcome into a machine-readable
//      verdict (met / partially met / unmet) with per-criterion evidence.
//   3. Bounded autonomy  — `decideAutonomousAction` is the single, explicit
//      decision function for the autonomous loop: continue / recover /
//      request_approval / finish / fail. It is bounded by construction.
//
// It also exposes `renderPlanContext`, a compact capability map + criteria block
// that makes planning context-aware (what the run can actually DO) instead of
// keyword-only, without replacing the existing planner prompt.
//
// Nothing here executes anything or touches the database: it is pure logic, so
// it is safe to call on every run and trivial to unit-test.
// =============================================================================

import { TOOL_CATALOG } from './catalog.mjs';

const MAX_CRITERIA = 8;

// -----------------------------------------------------------------------------
// Capability map (context-aware planning)
// -----------------------------------------------------------------------------

const CATEGORY_RULES = [
  { category: 'execute', match: (id) => id === 'code.run' || id === 'terminal.run' || id === 'browser.run' },
  { category: 'delivery', match: (id) => id === 'git.checkpoint' || id === 'git.push' || id.startsWith('github.pr.') || id === 'github.ci.rerun' || id === 'github.issue.create' || id === 'github.issue.comment' },
  { category: 'mutate', match: (id) => id === 'files.write' || id === 'files.patch' || id === 'workspace.apply' || id.startsWith('docx.') || id.startsWith('odt.') || id.startsWith('pptx.') || id.startsWith('xlsx.') || id === 'memory.write' || id === 'memory.consolidate' || id === 'speech.synthesize' || id === 'video.generate' || id === 'audio.generate' || id === 'image.generate' },
  { category: 'external', match: (id) => id === 'email.send' || id === 'slack.post' || id === 'teams.post' || id === 'discord.post' || id === 'notion.page.create' || id === 'webhook.post' || id === 'calendar.schedule' || id === 'image.analyze' || id === 'media.analyze' || id === 'speech.transcribe' },
  { category: 'read', match: () => true },
];

/** Group tool ids into capability categories (read / mutate / delivery / external / execute). */
export function categorizeTools(toolIds = [...TOOL_CATALOG.map((tool) => tool.id)]) {
  const groups = { read: [], mutate: [], delivery: [], external: [], execute: [] };
  for (const toolId of toolIds) {
    const rule = CATEGORY_RULES.find((candidate) => candidate.match(toolId));
    groups[rule.category].push(toolId);
  }
  return groups;
}

/**
 * Render a compact, bounded planning-context block: the detected task type, the
 * success criteria the run must satisfy, and a capability map of the tools that
 * are actually available. This is what makes planning context-aware rather than
 * keyword-only, while staying a single string the existing planner prompt
 * appends.
 */
export function renderPlanContext({ goal = '', taskType = null, toolIds, criteria = [], hints = [], notes = [] } = {}) {
  const groups = categorizeTools(toolIds);
  const lines = [];
  if (taskType) lines.push(`Task type: ${String(taskType).slice(0, 60)}`);
  const boundedCriteria = (criteria.length ? criteria : deriveSuccessCriteria(goal, { taskType })).slice(0, MAX_CRITERIA);
  if (boundedCriteria.length) {
    lines.push('Success criteria (the plan must be able to satisfy these):');
    for (const criterion of boundedCriteria) lines.push(`- ${criterion.text}`);
  }
  lines.push('Available capabilities (choose tools from these groups):');
  for (const [category, ids] of Object.entries(groups)) {
    if (ids.length) lines.push(`- ${category}: ${ids.join(', ')}`);
  }
  if (hints.length) lines.push(`Operator hints: ${hints.slice(0, 10).map((line) => String(line).slice(0, 160)).join(' | ')}`);
  if (notes.length) lines.push(`Learned notes: ${notes.slice(0, 10).map((line) => String(line).slice(0, 160)).join(' | ')}`);
  return lines.join('\n').slice(0, 6_000);
}

// -----------------------------------------------------------------------------
// Success criteria
// -----------------------------------------------------------------------------

const CRITERION_KINDS = Object.freeze(['change_applied', 'tests_pass', 'delivered', 'evidence_present', 'answer_present', 'no_failures', 'custom']);

const CHANGE_RE = /\b(fix|implement|add|create|refactor|edit|patch|update|change|write|build|generate|author|migrate|rename|remove|delete)\b|أصلح|أضف|عدّل|أنشئ|نفّذ|اكتب|غيّر|احذف/i;
const TEST_RE = /\b(test|tests|verify|verification|validate|check|lint|typecheck|ci)\b|اختبار|تحقّق|تحقق|فحص/i;
const DELIVER_RE = /\b(deliver|deploy|ship|push|merge|pull request|\bpr\b|commit|branch|release)\b|تسليم|دمج|فرع|نشر|التزام|طلب دمج/i;
const RESEARCH_RE = /\b(research|search|find|investigate|analyze|analyse|explain|summari[sz]e|report|document|compare|review)\b|ابحث|حلّل|اشرح|لخّص|تقرير|قارن|راجع/i;

function criterion(kind, text, required = true) {
  return { id: kind, kind, text, required };
}

/**
 * Deterministic success-criteria inference from the goal + task type. This is the
 * fallback used when the planner does not supply criteria, so a run ALWAYS has an
 * explicit, checkable definition of done.
 */
export function deriveSuccessCriteria(goal = '', { taskType = null } = {}) {
  const text = String(goal ?? '');
  const criteria = [];
  const isCode = /code|fix|bug|feature|refactor|implement|patch|file|module|function|class/i.test(String(taskType ?? '')) || CHANGE_RE.test(text);
  if (isCode) criteria.push(criterion('change_applied', 'the requested change is applied to the workspace'));
  if (TEST_RE.test(text) || isCode) criteria.push(criterion('tests_pass', 'tests or a verification command pass'));
  if (DELIVER_RE.test(text)) criteria.push(criterion('delivered', 'the change is delivered (branch/PR/CI verified)'));
  if (RESEARCH_RE.test(text) || !isCode) criteria.push(criterion('evidence_present', 'the findings are supported by retrieved evidence'));
  criteria.push(criterion('answer_present', 'a concrete final answer is produced'));
  criteria.push(criterion('no_failures', 'no step failed without a recorded recovery'));
  // De-duplicate by kind while preserving order.
  const seen = new Set();
  return criteria.filter((item) => (seen.has(item.kind) ? false : seen.add(item.kind)));
}

/**
 * Normalize a model-provided criteria list (strings or objects) into bounded
 * criterion objects. Unknown/blank entries are dropped; when the model supplies
 * nothing usable we fall back to `deriveSuccessCriteria`.
 */
export function normalizeSuccessCriteria(raw, { goal = '', taskType = null } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const normalized = [];
  const seen = new Set();
  for (const item of list) {
    if (normalized.length >= MAX_CRITERIA) break;
    let text = '';
    let kind = 'custom';
    if (typeof item === 'string') text = item;
    else if (item && typeof item === 'object') {
      text = String(item.text ?? item.criterion ?? item.description ?? '');
      const candidate = String(item.kind ?? '').toLowerCase();
      if (CRITERION_KINDS.includes(candidate)) kind = candidate;
    }
    text = text.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text) continue;
    if (kind === 'custom') kind = inferKind(text);
    const key = `${kind}:${text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(criterion(kind, text));
  }
  return normalized.length ? normalized : deriveSuccessCriteria(goal, { taskType });
}

function inferKind(text) {
  const lower = text.toLowerCase();
  if (/test|verify|verification|check|pass/.test(lower)) return 'tests_pass';
  if (/deliver|deploy|push|merge|pull request|pr |branch|ci/.test(lower)) return 'delivered';
  if (/evidence|source|cite|support|reference/.test(lower)) return 'evidence_present';
  if (/answer|report|summar|response|explain/.test(lower)) return 'answer_present';
  if (/no (step )?fail|without error|no error/.test(lower)) return 'no_failures';
  if (/change|apply|edit|write|create|add|fix|implement|update/.test(lower)) return 'change_applied';
  return 'custom';
}

// -----------------------------------------------------------------------------
// Completion check
// -----------------------------------------------------------------------------

const WRITE_TOOLS = new Set(['files.write', 'files.patch', 'workspace.apply', 'memory.write', 'memory.consolidate', 'docx.create', 'docx.edit', 'odt.create', 'odt.edit', 'pptx.create', 'pptx.edit', 'xlsx.create', 'xlsx.edit', 'speech.synthesize', 'video.generate', 'audio.generate', 'image.generate']);

const CRITERION_CHECKS = Object.freeze({
  change_applied: (ctx) => ctx.changedFiles > 0 || ctx.writeToolSucceeded,
  tests_pass: (ctx) => ctx.verificationPassed,
  delivered: (ctx) => ctx.delivered,
  evidence_present: (ctx) => ctx.evidenceCount > 0,
  answer_present: (ctx) => Boolean(ctx.finalAnswer && String(ctx.finalAnswer).trim()),
  no_failures: (ctx) => ctx.failedSteps === 0,
});

/**
 * Evaluate whether the run satisfied its success criteria using ONLY real
 * signals (tool outputs, verification evidence, delivery outcome, final answer).
 * A criterion whose kind has no deterministic check is marked `met: null`
 * (unknown) and never counts as a failure.
 */
export function evaluateCompletion({ outputs = [], verification = null, criteria = [], delivery = null, status = null, finalAnswer = '' } = {}) {
  const ctx = {
    changedFiles: Array.isArray(delivery?.changed) ? delivery.changed.length : 0,
    writeToolSucceeded: outputs.some((item) => item?.result?.ok !== false && WRITE_TOOLS.has(item?.toolId)),
    verificationPassed: verification?.status === 'VERIFIED' || outputs.some((item) => item?.result?.ok !== false && item?.verification === 'VERIFIED'),
    delivered: delivery?.delivered === true,
    evidenceCount: outputs.filter((item) => item?.evidenceId).length,
    failedSteps: outputs.filter((item) => item?.result?.ok === false).length,
    finalAnswer,
  };
  const evaluated = criteria.map((item) => {
    const check = CRITERION_CHECKS[item.kind];
    const met = typeof check === 'function' ? Boolean(check(ctx)) : null;
    return { id: item.id, kind: item.kind, text: item.text, met };
  });
  const satisfied = evaluated.filter((item) => item.met === true);
  const unmet = evaluated.filter((item) => item.met === false);
  const unknown = evaluated.filter((item) => item.met === null);
  const evaluable = satisfied.length + unmet.length;
  const score = evaluable ? satisfied.length / evaluable : (status === 'completed' ? 1 : 0);
  return {
    met: unmet.length === 0,
    score: Math.round(score * 1000) / 1000,
    satisfied: satisfied.map((item) => item.text),
    unmet: unmet.map((item) => item.text),
    unknown: unknown.map((item) => item.text),
    criteria: evaluated,
  };
}

// -----------------------------------------------------------------------------
// Bounded autonomous-loop decision
// -----------------------------------------------------------------------------

export const AUTONOMOUS_ACTIONS = Object.freeze(['continue', 'recover', 'request_approval', 'finish', 'fail']);

/**
 * The single decision function for the bounded autonomous loop. Given the current
 * state it returns exactly one action with a reason. It is bounded by
 * construction: recovery is only chosen while replan budget remains, and every
 * other branch terminates the loop.
 */
export function decideAutonomousAction({
  status = null,
  stepFailed = false,
  failureKind = 'UNKNOWN_FAILURE',
  replans = 0,
  maxReplans = 0,
  approvalsPending = 0,
  unmetCriteria = null,
  remainingSteps = 0,
  budgetExhausted = false,
  loopDetected = false,
} = {}) {
  const terminalSuccess = status === 'completed' || status === 'completed_with_warnings';
  if (approvalsPending > 0) return { action: 'request_approval', reason: 'approval_pending' };
  if (stepFailed) {
    // Recover while replan budget remains and the loop is not stuck; otherwise the
    // loop terminates. This mirrors the runtime's existing `replans < maxReplans`
    // gate EXACTLY (no behaviour change) while making the decision explicit and
    // auditable. The failure kind is preserved in the reason for operators.
    if (!loopDetected && Number(replans) < Number(maxReplans)) {
      return { action: 'recover', reason: failureKind === 'PERMISSION_FAILURE' ? 'permission_recoverable' : 'tool_failed_recoverable' };
    }
    return { action: 'fail', reason: failureKind === 'PERMISSION_FAILURE' ? 'permission_denied' : 'recovery_exhausted' };
  }
  if (terminalSuccess) return { action: 'finish', reason: unmetCriteria && unmetCriteria > 0 ? 'goal_partially_met' : 'goal_met' };
  if (budgetExhausted) return { action: 'finish', reason: 'budget_exhausted' };
  if (unmetCriteria && unmetCriteria > 0 && remainingSteps > 0) return { action: 'continue', reason: 'criteria_unmet' };
  if (status) return { action: 'finish', reason: 'terminal' };
  return { action: 'continue', reason: 'in_progress' };
}
