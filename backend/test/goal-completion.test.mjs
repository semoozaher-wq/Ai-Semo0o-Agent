import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTONOMOUS_ACTIONS,
  categorizeTools,
  decideAutonomousAction,
  deriveSuccessCriteria,
  evaluateCompletion,
  normalizeSuccessCriteria,
  renderPlanContext,
} from '../agent/goal-completion.mjs';

/**
 * Agent intelligence / goal-completion primitives. All pure, so they are tested
 * directly without a database. These cover the three behaviours the runtime now
 * depends on: success criteria, completion evaluation, and the bounded
 * autonomous-loop decision.
 */

/* ------------------------------ success criteria -------------------------- */

test('deriveSuccessCriteria infers a checkable definition of done for a code goal', () => {
  const criteria = deriveSuccessCriteria('fix the login bug', { taskType: 'code' });
  const kinds = criteria.map((criterion) => criterion.kind);
  assert.ok(kinds.includes('change_applied'), 'a code goal must require a change');
  assert.ok(kinds.includes('tests_pass'), 'a code goal must require tests/verification');
  assert.ok(kinds.includes('answer_present'), 'every goal must require a final answer');
  assert.ok(kinds.includes('no_failures'), 'every goal must require no unrecovered failures');
  // Every criterion carries a human-readable text and a stable id.
  for (const criterion of criteria) {
    assert.equal(criterion.id, criterion.kind);
    assert.ok(typeof criterion.text === 'string' && criterion.text.length > 0);
  }
});

test('deriveSuccessCriteria requires evidence for a research goal', () => {
  const kinds = deriveSuccessCriteria('summarize the findings about pricing', {}).map((criterion) => criterion.kind);
  assert.ok(kinds.includes('evidence_present'), 'a research goal must require evidence');
  assert.ok(!kinds.includes('change_applied'), 'a pure research goal must not require a workspace change');
});

test('deriveSuccessCriteria is deterministic and de-duplicated', () => {
  const first = deriveSuccessCriteria('implement and test the feature', { taskType: 'code' });
  const second = deriveSuccessCriteria('implement and test the feature', { taskType: 'code' });
  assert.deepEqual(first, second);
  const kinds = first.map((criterion) => criterion.kind);
  assert.equal(new Set(kinds).size, kinds.length, 'criteria must be unique by kind');
});

/* ---------------------------- normalize criteria -------------------------- */

test('normalizeSuccessCriteria accepts model strings and infers their kind', () => {
  const criteria = normalizeSuccessCriteria(['all tests pass', 'deliver the pull request'], {});
  assert.equal(criteria.length, 2);
  assert.equal(criteria[0].kind, 'tests_pass');
  assert.equal(criteria[1].kind, 'delivered');
});

test('normalizeSuccessCriteria honours an explicit kind and de-duplicates', () => {
  const criteria = normalizeSuccessCriteria([
    { kind: 'evidence_present', text: 'cite the sources' },
    { kind: 'evidence_present', text: 'Cite The Sources' },
  ], {});
  assert.equal(criteria.length, 1, 'duplicate criteria must collapse');
  assert.equal(criteria[0].kind, 'evidence_present');
});

test('normalizeSuccessCriteria falls back to derived criteria when the model supplies nothing usable', () => {
  const criteria = normalizeSuccessCriteria([], { goal: 'fix the bug', taskType: 'code' });
  assert.ok(criteria.some((criterion) => criterion.kind === 'change_applied'));
  const also = normalizeSuccessCriteria([{ text: '   ' }, 42], { goal: 'fix the bug', taskType: 'code' });
  assert.ok(also.length > 0, 'blank/invalid entries must not wipe out the fallback');
});

/* ---------------------------- completion check ---------------------------- */

test('evaluateCompletion reports met, unmet and unknown criteria with a score', () => {
  const criteria = [
    { id: 'answer_present', kind: 'answer_present', text: 'produce an answer' },
    { id: 'change_applied', kind: 'change_applied', text: 'apply a change' },
    { id: 'custom', kind: 'custom', text: 'an unverifiable criterion' },
  ];
  const result = evaluateCompletion({ criteria, finalAnswer: 'done', outputs: [], status: 'completed' });
  assert.equal(result.met, false, 'an unmet criterion makes the goal unmet');
  assert.deepEqual(result.satisfied, ['produce an answer']);
  assert.deepEqual(result.unmet, ['apply a change']);
  assert.deepEqual(result.unknown, ['an unverifiable criterion']);
  // 1 of 2 evaluable criteria satisfied.
  assert.equal(result.score, 0.5);
});

test('evaluateCompletion marks a goal met when every evaluable criterion is satisfied', () => {
  const criteria = [
    { id: 'answer_present', kind: 'answer_present', text: 'produce an answer' },
    { id: 'change_applied', kind: 'change_applied', text: 'apply a change' },
    { id: 'tests_pass', kind: 'tests_pass', text: 'tests pass' },
  ];
  const result = evaluateCompletion({
    criteria,
    finalAnswer: 'done',
    outputs: [{ toolId: 'files.write', result: { ok: true }, evidenceId: 'ev1' }],
    verification: { status: 'VERIFIED' },
    status: 'completed',
  });
  assert.equal(result.met, true);
  assert.equal(result.score, 1);
  assert.equal(result.unmet.length, 0);
});

test('evaluateCompletion treats an unknown-only criteria set as met on success', () => {
  const result = evaluateCompletion({ criteria: [{ id: 'c', kind: 'custom', text: 'x' }], status: 'completed' });
  assert.equal(result.met, true, 'unknown criteria never count as failures');
  assert.equal(result.score, 1);
});

/* --------------------------- autonomous decision -------------------------- */

test('AUTONOMOUS_ACTIONS exposes the full bounded action set', () => {
  assert.deepEqual([...AUTONOMOUS_ACTIONS], ['continue', 'recover', 'request_approval', 'finish', 'fail']);
});

test('decideAutonomousAction requests approval whenever an approval is pending', () => {
  const decision = decideAutonomousAction({ approvalsPending: 1, status: 'running' });
  assert.equal(decision.action, 'request_approval');
});

test('decideAutonomousAction recovers a failed step while replan budget remains', () => {
  const decision = decideAutonomousAction({ stepFailed: true, failureKind: 'TOOL_FAILURE', replans: 0, maxReplans: 2 });
  assert.equal(decision.action, 'recover');
  assert.equal(decision.reason, 'tool_failed_recoverable');
});

test('decideAutonomousAction fails a step once the replan budget is exhausted', () => {
  const decision = decideAutonomousAction({ stepFailed: true, failureKind: 'TOOL_FAILURE', replans: 2, maxReplans: 2 });
  assert.equal(decision.action, 'fail');
  assert.equal(decision.reason, 'recovery_exhausted');
});

test('decideAutonomousAction never recovers a detected loop', () => {
  const decision = decideAutonomousAction({ stepFailed: true, replans: 0, maxReplans: 3, loopDetected: true });
  assert.equal(decision.action, 'fail');
});

test('decideAutonomousAction distinguishes a permission failure in its reason', () => {
  assert.equal(decideAutonomousAction({ stepFailed: true, failureKind: 'PERMISSION_FAILURE', replans: 0, maxReplans: 2 }).reason, 'permission_recoverable');
  assert.equal(decideAutonomousAction({ stepFailed: true, failureKind: 'PERMISSION_FAILURE', replans: 2, maxReplans: 2 }).reason, 'permission_denied');
});

test('decideAutonomousAction finishes on a terminal success and flags partial goals', () => {
  assert.equal(decideAutonomousAction({ status: 'completed' }).action, 'finish');
  assert.equal(decideAutonomousAction({ status: 'completed', unmetCriteria: 2 }).reason, 'goal_partially_met');
  assert.equal(decideAutonomousAction({ status: 'completed_with_warnings' }).action, 'finish');
});

test('decideAutonomousAction continues while criteria remain unmet and steps remain', () => {
  const decision = decideAutonomousAction({ status: 'running', unmetCriteria: 1, remainingSteps: 3 });
  assert.equal(decision.action, 'continue');
  assert.equal(decision.reason, 'criteria_unmet');
});

test('decideAutonomousAction finishes when the budget is exhausted', () => {
  assert.equal(decideAutonomousAction({ status: 'running', budgetExhausted: true }).reason, 'budget_exhausted');
});

/* --------------------------- planning context ----------------------------- */

test('categorizeTools groups tools into capability categories', () => {
  const groups = categorizeTools(['code.run', 'files.write', 'git.push', 'email.send', 'files.read']);
  assert.deepEqual(groups.execute, ['code.run']);
  assert.deepEqual(groups.mutate, ['files.write']);
  assert.deepEqual(groups.delivery, ['git.push']);
  assert.deepEqual(groups.external, ['email.send']);
  assert.deepEqual(groups.read, ['files.read']);
});

test('renderPlanContext produces a bounded, context-aware planning block', () => {
  const context = renderPlanContext({ goal: 'fix the bug', taskType: 'code', toolIds: ['code.run', 'files.write'] });
  assert.match(context, /Task type: code/);
  assert.match(context, /Success criteria/);
  assert.match(context, /Available capabilities/);
  assert.match(context, /execute: code\.run/);
  assert.match(context, /mutate: files\.write/);
  assert.ok(context.length <= 6_000, 'the context block must stay bounded');
});
