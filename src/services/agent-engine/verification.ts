import type { PlanStep } from '../../types/task';

export type VerificationStatus = 'VERIFIED' | 'FAILED' | 'BLOCKED' | 'UNVERIFIED';

export type FailureKind =
  | 'TOOL_FAILURE'
  | 'EXECUTION_FAILURE'
  | 'TEST_FAILURE'
  | 'VALIDATION_FAILURE'
  | 'PERMISSION_FAILURE'
  | 'ENVIRONMENT_FAILURE'
  | 'PLANNING_FAILURE'
  | 'UNKNOWN_FAILURE';

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

export function classifyFailure(error: unknown, fallback: FailureKind = 'UNKNOWN_FAILURE'): FailureKind {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  const text = `${code} ${message}`.toLowerCase();
  if (text.includes('permission') || text.includes('denied')) return 'PERMISSION_FAILURE';
  if (text.includes('timeout') || text.includes('spawn') || text.includes('execution')) return 'EXECUTION_FAILURE';
  if (text.includes('invalid') || text.includes('validation')) return 'VALIDATION_FAILURE';
  if (text.includes('test') || text.includes('assert')) return 'TEST_FAILURE';
  if (text.includes('tool')) return 'TOOL_FAILURE';
  if (text.includes('plan') || text.includes('planner')) return 'PLANNING_FAILURE';
  if (text.includes('environment') || text.includes('not found')) return 'ENVIRONMENT_FAILURE';
  return fallback;
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
