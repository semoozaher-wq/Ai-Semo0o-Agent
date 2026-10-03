import { create } from 'zustand';
import { Task, TaskStep } from '../types/task';
import { LogLevel } from '../services/agent-engine/executor';
import { agentOrchestrator, OrchestratorEvent } from '../services/agent-engine/orchestrator';
import { TOOLS } from '../../data/tools';
import { providerRegistry } from '../services/ai';
import { storage, STORAGE_KEYS } from '../services/storage';
import { uid } from '../utils/id';
import { DEFAULT_MODEL_ID } from '../data/models';

export interface ApprovalRequest {
  id: string;
  toolId: string;
  toolName: string;
  reason: string;
  affectedFiles: string[];
  reversible: boolean;
  risk: 'medium' | 'high';
  resolve: (approved: boolean) => void;
}

export interface LogEntry {
  id: string;
  message: string;
  level: LogLevel;
  at: string;
}

let cancelSignal = { cancelled: false };

interface AgentsState {
  tasks: Task[];
  logs: Record<string, LogEntry[]>;
  runningId: string | null;
  approvalRequest: ApprovalRequest | null;
  hydrated: boolean;
  hydrate(): Promise<void>;
  createTask(goal: string, opts?: { title?: string; model?: string; agentId?: string }): Task;
  runTask(id: string, opts?: { model?: string }): Promise<void>;
  cancel(): void;
  approve(): void;
  reject(): void;
  removeTask(id: string): Promise<void>;
  clear(): Promise<void>;
}

function runStatus(status: string): Task['status'] {
  if (status === 'completed') return 'completed';
  if (status === 'completed_with_warnings') return 'completed_with_warnings';
  if (status === 'blocked') return 'blocked';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'unverified') return 'unverified';
  return 'failed';
}

function eventLog(next: OrchestratorEvent): { message: string; level: LogLevel } | undefined {
  switch (next.type) {
    case 'planning_started': return { message: '● فهم الهدف وبدء التخطيط…', level: 'info' };
    case 'planning_completed': return { message: `✓ تم إنشاء الخطة (${String(next.details?.steps ?? 0)} خطوات).`, level: 'success' };
    case 'planning_failed': return { message: `✗ فشل التخطيط: ${String(next.details?.error ?? '')}`, level: 'error' };
    case 'permission_requested': return { message: `⚠ بانتظار موافقة المستخدم على ${next.toolId ?? 'أداة خطرة'}`, level: 'warn' };
    case 'step_started': return { message: `● ${String(next.details?.title ?? next.stepId ?? 'بدء خطوة')}`, level: 'info' };
    case 'tool_completed': return next.details?.ok
      ? { message: `✓ اكتمل تنفيذ ${next.toolId ?? 'الأداة'}${Number(next.details?.attempt ?? 0) > 1 ? ` — محاولة ${String(next.details?.attempt)}` : ''}`, level: 'success' }
      : { message: `✗ فشل تنفيذ ${next.toolId ?? 'الأداة'}: ${String(next.details?.error ?? '')}`, level: 'error' };
    case 'step_completed': return next.details?.verified
      ? { message: `✓ تم التحقق من ${next.stepId ?? 'الخطوة'}`, level: 'success' }
      : { message: `● حالة التحقق: ${String(next.details?.verification ?? 'UNVERIFIED')}`, level: 'warn' };
    case 'verification_required': return { message: '⚠ لا يوجد دليل تحقق كافٍ.', level: 'warn' };
    case 'run_finished': return { message: `انتهى التشغيل: ${String(next.details?.status ?? '')}`, level: next.details?.status === 'completed' ? 'success' : 'warn' };
    default: return undefined;
  }
}

function updateLiveStep(task: Task, next: OrchestratorEvent): Task {
  if (!next.stepId) return task;
  const existingIndex = task.steps.findIndex((step) => step.id === next.stepId);
  const current = existingIndex >= 0 ? task.steps[existingIndex] : {
    id: next.stepId,
    index: task.steps.length,
    kind: (next.details?.kind ?? 'tool') as TaskStep['kind'],
    title: String(next.details?.title ?? next.stepId),
    description: String(next.details?.title ?? next.stepId),
    dependsOn: [],
    status: 'pending' as const,
  };
  const patch: Partial<TaskStep> = next.type === 'step_started'
    ? { status: 'running', startedAt: new Date().toISOString() }
    : next.type === 'step_completed'
      ? {
          status: next.details?.verified ? 'completed' : 'failed',
          finishedAt: new Date().toISOString(),
          verificationStatus: String(next.details?.verification ?? (next.details?.verified ? 'VERIFIED' : 'UNVERIFIED')) as TaskStep['verificationStatus'],
        }
      : {};
  const steps = [...task.steps];
  if (existingIndex >= 0) steps[existingIndex] = { ...current, ...patch };
  else steps.push({ ...current, ...patch });
  return { ...task, steps, status: task.status === 'queued' || task.status === 'planning' ? 'running' : task.status, updatedAt: new Date().toISOString() };
}

export const useAgentsStore = create<AgentsState>((set, get) => {
  const persist = () => { void storage.set(STORAGE_KEYS.tasks, get().tasks); };
  const updateTask = (task: Task) => set((state) => ({ tasks: state.tasks.map((item) => item.id === task.id ? task : item) }));
  const appendLog = (id: string, message: string, level: LogLevel) => set((state) => ({
    logs: { ...state.logs, [id]: [...(state.logs[id] ?? []), { id: uid('log'), message, level, at: new Date().toISOString() }] },
  }));

  return {
    tasks: [],
    logs: {},
    runningId: null,
    approvalRequest: null,
    hydrated: false,
    async hydrate() {
      set({ tasks: (await storage.get<Task[]>(STORAGE_KEYS.tasks)) ?? [], hydrated: true });
    },
    createTask(goal, opts) {
      const task: Task = {
        id: uid('task'),
        title: opts?.title ?? goal.slice(0, 60),
        goal,
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: [],
        progress: 0,
        agentId: opts?.agentId,
        model: opts?.model ?? DEFAULT_MODEL_ID,
      };
      set((state) => ({ tasks: [task, ...state.tasks] }));
      persist();
      return task;
    },
    async runTask(id, opts) {
      const task = get().tasks.find((item) => item.id === id);
      if (!task) return;
      cancelSignal = { cancelled: false };
      set((state) => ({ runningId: id, logs: { ...state.logs, [id]: [] } }));
      const model = opts?.model ?? task.model ?? DEFAULT_MODEL_ID;
      const providers = providerRegistry.list()
        .map((providerId) => providerRegistry.get(providerId))
        .filter((provider): provider is NonNullable<typeof provider> => Boolean(provider));
      if (providers.length === 0) {
        updateTask({ ...task, status: 'failed', error: 'لا يوجد مزود AI متصل. أضف مفتاح API من الإعدادات.', updatedAt: new Date().toISOString() });
        set({ runningId: null });
        persist();
        return;
      }
      const result = await agentOrchestrator.run({
        taskId: id,
        goal: task.goal,
        model,
        providers,
        tools: TOOLS,
        signal: cancelSignal,
        requestPermission: async ({ tool, step }) => new Promise<boolean>((resolve) => {
          const args = step.toolArgs ?? {};
          const affectedFiles = [args.path, ...(Array.isArray(args.paths) ? args.paths : [])]
            .filter((value): value is string => typeof value === 'string');
          let settled = false;
          let watch: ReturnType<typeof setInterval>;
          let timeout: ReturnType<typeof setTimeout>;
          const finish = (approved: boolean) => {
            if (settled) return;
            settled = true;
            clearInterval(watch);
            clearTimeout(timeout);
            resolve(approved);
          };
          watch = setInterval(() => {
            if (cancelSignal.cancelled) finish(false);
          }, 100);
          timeout = setTimeout(() => finish(false), 5 * 60 * 1000);
          set({ approvalRequest: {
            id: uid('approval'),
            toolId: tool.id,
            toolName: tool.nameAr,
            reason: step.description,
            affectedFiles,
            reversible: !['workspace.delete', 'email.send'].includes(tool.id),
            risk: ['workspace.delete', 'email.send', 'code.run'].includes(tool.id) ? 'high' : 'medium',
            resolve: finish,
          } });
        }),
        onEvent: (next) => {
          const log = eventLog(next);
          if (log) appendLog(id, log.message, log.level);
          const current = get().tasks.find((item) => item.id === id);
          if (current && next.type !== 'run_finished') updateTask(updateLiveStep(current, next));
        },
      });
      const current = get().tasks.find((item) => item.id === id) ?? task;
      const finalSteps: TaskStep[] = result.plan?.steps.map((step) => {
        const prior = current.steps.find((item) => item.id === step.id);
        const evidence = result.evidence.filter((item) => item.stepId === step.id);
        let verification = result.verifications[result.verifications.length - 1];
        for (const candidate of result.verifications) {
          if (candidate.evidenceIds.some((evidenceId) => evidenceId.startsWith(`${result.plan?.id}:${step.id}:`))) verification = candidate;
        }
        return {
          ...(prior ?? step),
          ...step,
          status: verification?.status === 'VERIFIED' ? 'completed' : verification ? 'failed' : prior?.status ?? step.status,
          verificationStatus: verification?.status,
          evidenceIds: evidence.map((item) => item.id),
          retries: Math.max(0, evidence.length - 1),
        };
      }) ?? current.steps;
      const finalTask: Task = {
        ...current,
        status: runStatus(result.status),
        plan: result.plan,
        steps: finalSteps,
        result: result.outputs.map((output) => `${output.toolId ?? 'step'}: ${JSON.stringify(output.output)}`).join('\n') || undefined,
        error: result.errors.join('\n') || undefined,
        progress: result.status === 'completed' ? 1 : finalSteps.length ? finalSteps.filter((step) => step.status === 'completed').length / finalSteps.length : 0,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      updateTask(finalTask);
      appendLog(id, `انتهى التشغيل: ${result.status}`, result.status === 'completed' ? 'success' : 'warn');
      set({ runningId: null, approvalRequest: null });
      persist();
    },
    cancel() { cancelSignal.cancelled = true; },
    approve() {
      const request = get().approvalRequest;
      if (!request) return;
      set({ approvalRequest: null });
      request.resolve(true);
    },
    reject() {
      const request = get().approvalRequest;
      if (!request) return;
      set({ approvalRequest: null });
      request.resolve(false);
    },
    async removeTask(id) {
      set((state) => { const logs = { ...state.logs }; delete logs[id]; return { tasks: state.tasks.filter((item) => item.id !== id), logs }; });
      persist();
    },
    async clear() {
      set({ tasks: [], logs: {}, runningId: null, approvalRequest: null });
      await storage.remove(STORAGE_KEYS.tasks);
    },
  };
});
