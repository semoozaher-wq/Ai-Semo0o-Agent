import { ToolInvocation } from './tool';

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'paused'
  | 'completed'
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
  toolId?: string;
  /** Arguments are validated again by the tool runtime before execution. */
  toolArgs?: Record<string, unknown>;
}

export interface TaskStep extends PlanStep {
  startedAt?: string;
  finishedAt?: string;
  output?: string;
  toolInvocations?: ToolInvocation[];
  error?: string;
  logs?: string[];
  verificationStatus?: 'VERIFIED' | 'FAILED' | 'BLOCKED' | 'UNVERIFIED';
  evidenceIds?: string[];
  retries?: number;
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
  startedAt?: string;
  finishedAt?: string;
  plan?: Plan;
  steps: TaskStep[];
  /** 0..1 */
  progress: number;
  agentId?: string;
  model: string;
  result?: string;
  error?: string;
  tokensUsed?: number;
  iterations?: number;
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
