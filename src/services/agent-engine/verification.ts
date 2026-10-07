import recoveryContract from '../../../shared/recovery-contract.json';
import type { PlanStep } from '../../types/task';

export type VerificationStatus = 'VERIFIED' | 'FAILED' | 'BLOCKED' | 'UNVERIFIED';

/**
 * The failure taxonomy is the SAME union the Node backend uses. The canonical
 * list lives in `shared/recovery-contract.json` (imported below and by
 * `backend/agent/recovery.mjs`) so the two runtimes can never drift; this
 * explicit union keeps the strong compile-time typing that a JSON import alone
 * cannot provide, and the parity test asserts the two stay identical.
 */
export type FailureKind =
  | 'TOOL_FAILURE'
  | 'EXECUTION_FAILURE'
  | 'TEST_FAILURE'
  | 'VALIDATION_FAILURE'
  | 'PERMISSION_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'PLANNING_FAILURE'
  | 'UNKNOWN_FAILURE';

/** The bounded recovery actions, shared with the backend. */
export type RecoveryAction = 'retry' | 'repair' | 'replan' | 'block';

/**
 * The single recovery contract shared by the React Native frontend and the Node
 * backend. Everything that must behave identically on both sides is read from
 * here: the failure taxonomy, the recovery actions, the event names and the
 * classifier table. There is no second recovery architecture — only one shared
 * contract with a thin adapter on each side.
 */
export const FAILURE_KINDS: readonly FailureKind[] = recoveryContract.failureKinds as readonly FailureKind[];
export const RECOVERY_ACTIONS: readonly RecoveryAction[] = recoveryContract.recoveryActions as readonly RecoveryAction[];
export const RECOVERY_EVENTS: RecoveryEvents = recoveryContract.events as RecoveryEvents;
export const MAX_RECOVERY_ATTEMPTS: number = recoveryContract.maxAttempts;

/** The shared recovery event names, strongly typed for the orchestrator. */
export interface RecoveryEvents {
  routingDecision: 'routing_decision';
  planningFailed: 'planning_failed';
  selfHealing: 'self_healing';
  selfHealingFailed: 'self_healing_failed';
  rerouteFailed: 'reroute_failed';
}

export interface Evidence {
  id: string;
  runId: string;
  taskId: string;
  stepId: string;
  toolCallId?: string;
  kind: 'toolResult' | 'command' | 'testResult' | 'file' | 'browserResult' | 'verificationResult';
  input?: unknown;
  output?: unknown;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  file?: string;
  fileHash?: string;
  diff?: unknown;
  screenshot?: string;
  browserResult?: unknown;
  simulated: boolean;
  timestamp: string;
}

export interface VerificationCriteria {
  id: string;
  description: string;
  required: boolean;
  check: 'evidence_present' | 'execution_ok' | 'output_present' | 'not_simulated' | 'output_includes';
  value?: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  criteria: { id: string; passed: boolean; description: string; reason?: string | undefined }[];
  evidenceIds: string[];
  failureKind?: FailureKind | undefined;
  summary: string;
  verifiedAt: string;
}

export interface VerificationInput {
  task: PlanStep;
  expectedResult?: string;
  actualResult?: unknown;
  evidence: Evidence[];
  criteria?: VerificationCriteria[];
}

/**
 * Classify an error into the shared failure taxonomy using the contract's
 * ordered classifier table (the exact same table the backend uses). The `code`
 * property, when present, is inspected alongside the message.
 */
export function classifyFailure(error: unknown, fallback: FailureKind = 'UNKNOWN_FAILURE'): FailureKind {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const text = `${code} ${message}`.toLowerCase();
  for (const rule of recoveryContract.classifiers) {
    if (rule.patterns.some((pattern) => text.includes(pattern))) return rule.kind as FailureKind;
  }
  return fallback;
}

/**
 * The bounded recovery policy, byte-for-byte the same decision the backend
 * makes: a permission failure blocks immediately, everything else is repaired
 * while attempts remain and then replanned (or blocked when replanning is not
 * available). It never allows an unbounded loop.
 */
export function recoveryActionFor({
  failureKind = 'UNKNOWN_FAILURE',
  attempt = 1,
  maxAttempts = MAX_RECOVERY_ATTEMPTS,
  canRepair = true,
  canReplan = true,
}: {
  failureKind?: FailureKind;
  attempt?: number;
  maxAttempts?: number;
  canRepair?: boolean;
  canReplan?: boolean;
} = {}): RecoveryAction {
  if (failureKind === 'PERMISSION_FAILURE') return 'block';
  if (attempt < Math.max(1, Number(maxAttempts) || 1) && canRepair) return 'repair';
  if (canReplan) return 'replan';
  return 'block';
}

export function defaultCriteria(step: PlanStep): VerificationCriteria[] {
  return [
    { id: `${step.id}:evidence`, description: 'Evidence exists for the executed step.', required: true, check: 'evidence_present' },
    { id: `${step.id}:execution`, description: 'The tool execution returned ok=true.', required: true, check: 'execution_ok' },
    { id: `${step.id}:output`, description: 'The execution produced an actual output.', required: true, check: 'output_present' },
    { id: `${step.id}:live`, description: 'The evidence is not simulated.', required: true, check: 'not_simulated' },
  ];
}

export function verifyEvidence(input: VerificationInput): VerificationResult {
  const criteria = input.criteria?.length ? input.criteria : defaultCriteria(input.task);
  const evidence = input.evidence;
  const primary = evidence[evidence.length - 1];
  const checks = criteria.map((criterion) => {
    switch (criterion.check) {
      case 'evidence_present':
        return { id: criterion.id, passed: evidence.length > 0, description: criterion.description, reason: evidence.length ? undefined : 'No evidence was collected.' };
      case 'execution_ok':
        return { id: criterion.id, passed: primary?.output !== undefined && (primary.output as { ok?: unknown })?.ok !== false, description: criterion.description, reason: primary ? undefined : 'No execution result exists.' };
      case 'output_present':
        return { id: criterion.id, passed: input.actualResult !== undefined && input.actualResult !== null, description: criterion.description, reason: 'Execution output is empty.' };
      case 'not_simulated':
        return { id: criterion.id, passed: primary !== undefined && primary.simulated === false, description: criterion.description, reason: 'Simulated results cannot be verification evidence.' };
      case 'output_includes': {
        const actual = typeof input.actualResult === 'string' ? input.actualResult : JSON.stringify(input.actualResult ?? '');
        const passed = actual.includes(criterion.value ?? '');
        return { id: criterion.id, passed, description: criterion.description, reason: passed ? undefined : `Expected output to include: ${criterion.value ?? ''}` };
      }
      default:
        return { id: criterion.id, passed: false, description: criterion.description, reason: 'Unknown verification criterion.' };
    }
  });
  const requiredFailed = checks.some((check, index) => criteria[index]?.required && !check.passed);
  const executionFailed = (primary?.output as { ok?: unknown } | undefined)?.ok === false;
  const status: VerificationStatus = requiredFailed
    ? (executionFailed || (evidence.length && input.actualResult !== undefined && input.actualResult !== null) ? 'FAILED' : 'UNVERIFIED')
    : 'VERIFIED';
  return {
    status,
    criteria: checks,
    evidenceIds: evidence.map((item) => item.id),
    failureKind: status === 'VERIFIED' ? undefined : classifyFailure(checks.find((check) => !check.passed)?.reason, 'VALIDATION_FAILURE'),
    summary: status === 'VERIFIED' ? 'All required verification criteria passed.' : checks.filter((check) => !check.passed).map((check) => check.reason ?? check.description).join('; '),
    verifiedAt: new Date().toISOString(),
  };
}
