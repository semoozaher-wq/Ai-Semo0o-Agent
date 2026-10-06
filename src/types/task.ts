import { ToolInvocation } from './tool';

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_warnings'
  | 'blocked'
  | 'unverified'
  | 'failed'
  | 'cancelled';

export type StepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export type StepKind =
  | 'reason'
  | 'tool'
  | 'search'
  | 'code'
  | 'write'
  | 'analyze'
  | 'verify'
  | 'reflect';

export interface PlanStep {
  id: string;
  index: number;
  kind: StepKind;
  title: string;
  description: string;
  dependsOn: string[];
  status: StepStatus;
  /** Optional tool selected by an LLM planner for this step. */
  toolId?: string | undefined;
  /** Arguments are validated again by the tool runtime before execution. */
  toolArgs?: Record<string, unknown> | undefined;
}

export interface TaskStep extends PlanStep {
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  output?: string | undefined;
  toolInvocations?: ToolInvocation[] | undefined;
  error?: string | undefined;
  logs?: string[] | undefined;
  verificationStatus?: 'VERIFIED' | 'FAILED' | 'BLOCKED' | 'UNVERIFIED' | undefined;
  evidenceIds?: string[] | undefined;
  retries?: number | undefined;
}

export interface Plan {
  id: string;
  goal: string;
  createdAt: string;
  steps: PlanStep[];
  reasoning: string;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  plan?: Plan | undefined;
  steps: TaskStep[];
  /** 0..1 */
  progress: number;
  agentId?: string | undefined;
  model: string;
  result?: string | undefined;
  error?: string | undefined;
  tokensUsed?: number | undefined;
  iterations?: number | undefined;
}

export interface TaskTemplate {
  id: string;
  title: string;
  titleAr: string;
  goal: string;
  icon: string;
  category: string;
  estimatedSteps: number;
}
