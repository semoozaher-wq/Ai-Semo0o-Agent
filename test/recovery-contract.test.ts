import assert from 'node:assert/strict';
import test from 'node:test';
import recoveryContract from '../shared/recovery-contract.json';
import * as backendRecovery from '../backend/agent/recovery.mjs';
import * as frontendRecovery from '../src/services/agent-engine/verification';

/*
 * ---------------------------------------------------------------------------
 *  Recovery contract parity (backend <-> frontend)
 * ---------------------------------------------------------------------------
 *  The failure taxonomy, the recovery actions, the event names and the bounded
 *  recovery policy are defined ONCE in `shared/recovery-contract.json` and
 *  consumed by both runtimes:
 *
 *    * Node backend  -> backend/agent/recovery.mjs
 *    * RN frontend   -> src/services/agent-engine/verification.ts
 *
 *  These tests are the guard-rail that keeps the two sides byte-for-byte
 *  identical. If someone edits one side without the other, CI fails here instead
 *  of the two runtimes silently drifting into a "second architecture".
 * ---------------------------------------------------------------------------
 */

const backend = backendRecovery as {
  FAILURE_KINDS: readonly string[];
  RECOVERY_ACTIONS: readonly string[];
  RECOVERY_EVENTS: Record<string, string>;
  MAX_RECOVERY_ATTEMPTS: number;
  classifyFailure: (error: unknown, fallback?: string) => string;
  recoveryActionFor: (input?: Record<string, unknown>) => string;
};

const frontend = frontendRecovery as unknown as {
  FAILURE_KINDS: readonly string[];
  RECOVERY_ACTIONS: readonly string[];
  RECOVERY_EVENTS: Record<string, string>;
  MAX_RECOVERY_ATTEMPTS: number;
  classifyFailure: (error: unknown, fallback?: string) => string;
  recoveryActionFor: (input?: Record<string, unknown>) => string;
};

test('both runtimes expose the same failure taxonomy as the shared contract', () => {
  assert.deepEqual([...backend.FAILURE_KINDS], recoveryContract.failureKinds);
  assert.deepEqual([...frontend.FAILURE_KINDS], recoveryContract.failureKinds);
  assert.deepEqual([...backend.FAILURE_KINDS], [...frontend.FAILURE_KINDS]);
});

test('both runtimes expose the same recovery actions', () => {
  assert.deepEqual([...backend.RECOVERY_ACTIONS], recoveryContract.recoveryActions);
  assert.deepEqual([...frontend.RECOVERY_ACTIONS], recoveryContract.recoveryActions);
});

test('both runtimes expose the same event names', () => {
  assert.deepEqual(backend.RECOVERY_EVENTS, recoveryContract.events);
  assert.deepEqual(frontend.RECOVERY_EVENTS, recoveryContract.events);
  assert.equal(backend.RECOVERY_EVENTS.selfHealing, 'self_healing');
  assert.equal(backend.RECOVERY_EVENTS.selfHealingFailed, 'self_healing_failed');
  assert.equal(backend.RECOVERY_EVENTS.routingDecision, 'routing_decision');
  assert.equal(backend.RECOVERY_EVENTS.rerouteFailed, 'reroute_failed');
});

test('both runtimes share the same bounded attempt budget', () => {
  assert.equal(backend.MAX_RECOVERY_ATTEMPTS, recoveryContract.maxAttempts);
  assert.equal(frontend.MAX_RECOVERY_ATTEMPTS, recoveryContract.maxAttempts);
});

test('classifyFailure returns the same kind on both sides for the same error', () => {
  const cases: Array<{ error: unknown; fallback?: string }> = [
    { error: new Error('Permission denied for tool') },
    { error: new Error('execution timeout after 30s') },
    { error: new Error('invalid argument: path') },
    { error: new Error('test assertion failed') },
    { error: new Error('tool unavailable') },
    { error: new Error('planner could not produce a plan') },
    { error: new Error('environment not found') },
    { error: { code: 'EACCES', message: 'permission denied' } },
    { error: new Error('something totally unrelated') },
    { error: 'string failure with test inside' },
    { error: undefined, fallback: 'UNKNOWN_FAILURE' },
  ];
  for (const { error, fallback } of cases) {
    const backendKind = backend.classifyFailure(error, fallback);
    const frontendKind = frontend.classifyFailure(error, fallback);
    assert.equal(backendKind, frontendKind, `classifyFailure mismatch for ${JSON.stringify(error)}`);
    assert.ok(recoveryContract.failureKinds.includes(backendKind), `${backendKind} must be a contract failure kind`);
  }
});

test('classifyFailure honours the caller fallback identically on both sides', () => {
  const unknown = new Error('no keyword here at all');
  assert.equal(backend.classifyFailure(unknown, 'TOOL_FAILURE'), 'TOOL_FAILURE');
  assert.equal(frontend.classifyFailure(unknown, 'TOOL_FAILURE'), 'TOOL_FAILURE');
});

test('recoveryActionFor makes the exact same bounded decision on both sides', () => {
  const matrix: Array<Record<string, unknown>> = [
    { failureKind: 'PERMISSION_FAILURE', attempt: 1, maxAttempts: 3, canRepair: true, canReplan: true },
    { failureKind: 'TOOL_FAILURE', attempt: 1, maxAttempts: 3, canRepair: true, canReplan: true },
    { failureKind: 'TOOL_FAILURE', attempt: 3, maxAttempts: 3, canRepair: true, canReplan: true },
    { failureKind: 'TOOL_FAILURE', attempt: 3, maxAttempts: 3, canRepair: false, canReplan: true },
    { failureKind: 'EXECUTION_FAILURE', attempt: 2, maxAttempts: 2, canRepair: true, canReplan: false },
    { failureKind: 'VALIDATION_FAILURE', attempt: 1, maxAttempts: 1, canRepair: true, canReplan: true },
    {},
  ];
  for (const input of matrix) {
    const backendAction = backend.recoveryActionFor(input);
    const frontendAction = frontend.recoveryActionFor(input);
    assert.equal(backendAction, frontendAction, `recoveryActionFor mismatch for ${JSON.stringify(input)}`);
    assert.ok(recoveryContract.recoveryActions.includes(backendAction), `${backendAction} must be a contract action`);
  }
});

test('the bounded policy never allows an unbounded retry loop', () => {
  // A permission failure blocks immediately (no retry).
  assert.equal(frontend.recoveryActionFor({ failureKind: 'PERMISSION_FAILURE', attempt: 1, maxAttempts: 3 }), 'block');
  // Once attempts are exhausted, it replans (never "repair" again).
  assert.equal(frontend.recoveryActionFor({ failureKind: 'TOOL_FAILURE', attempt: 3, maxAttempts: 3 }), 'replan');
  // With no replanning available it blocks.
  assert.equal(frontend.recoveryActionFor({ failureKind: 'TOOL_FAILURE', attempt: 3, maxAttempts: 3, canReplan: false }), 'block');
});

test('the shared contract file is internally consistent', () => {
  assert.equal(recoveryContract.version, 1);
  assert.ok(Array.isArray(recoveryContract.classifiers) && recoveryContract.classifiers.length > 0);
  for (const rule of recoveryContract.classifiers) {
    assert.ok(recoveryContract.failureKinds.includes(rule.kind), `classifier kind ${rule.kind} must be a failure kind`);
    assert.ok(Array.isArray(rule.patterns) && rule.patterns.length > 0, `classifier ${rule.kind} needs patterns`);
  }
});
