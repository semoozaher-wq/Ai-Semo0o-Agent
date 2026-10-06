import { create } from 'zustand';
import { Task, TaskStep } from '../types/task';
import { LogLevel } from '../services/agent-engine/executor';
import { backendApi, ApiEvent } from '../services/api/client';
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
let activeRunId: string | null = null;

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

function eventLog(next: ApiEvent): { message: string; level: LogLevel } | undefined {
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

function updateLiveStep(task: Task, next: ApiEvent & { stepId?: string; details?: Record<string, unknown> }): Task {
  if (!next.stepId) return task;
  const existingIndex = task.steps.findIndex((step) => step.id === next.stepId);
  const current: TaskStep = (existingIndex >= 0 ? task.steps[existingIndex] : undefined) ?? {
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
      const appendBackendEvent = (next: ApiEvent, runId: string) => {
        const log = eventLog(next);
        if (log) appendLog(id, log.message, log.level);
        if (next.type === 'permission_requested') {
          set({ approvalRequest: {
            id: String(next.approvalId ?? uid('approval')),
            toolId: String(next.toolId ?? ''),
            toolName: String(next.toolId ?? ''),
            reason: String(next.reason ?? 'موافقة مطلوبة'),
            affectedFiles: [],
            reversible: false,
            risk: 'high',
            resolve: (approved) => { void backendApi.approve(runId, approved ? 'allow' : 'deny'); set({ approvalRequest: null }); },
          } });
        }
        const current = get().tasks.find((item) => item.id === id);
        if (current && next.type === 'step_started' && next.stepId) updateTask(updateLiveStep(current, { type: 'step_started', stepId: String(next.stepId), details: { title: next.title, kind: 'tool' } } as never));
      };
      try {
        const project = await (async () => { await backendApi.ensureSession(); return backendApi.createProject({ name: `Task ${task.title}` }); })();
        const run = await backendApi.createRun({ kind: 'agent.run', projectId: project.projectId, workspaceId: project.workspaceId, goal: task.goal, model: opts?.model ?? task.model });
        activeRunId = run.runId;
        await backendApi.streamEvents(run.runId, (event) => { if (!cancelSignal.cancelled) appendBackendEvent(event, run.runId); });
        const snapshot = await backendApi.getRun(run.runId);
        const current = get().tasks.find((item) => item.id === id) ?? task;
        const status = runStatus(snapshot.status);
        const finalTask: Task = { ...current, status, result: snapshot.result?.final ?? JSON.stringify(snapshot.result ?? {}), error: status === 'completed' ? undefined : snapshot.status, progress: status === 'completed' ? 1 : current.progress, updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
        updateTask(finalTask);
        appendLog(id, `انتهى التشغيل: ${snapshot.status}`, status === 'completed' ? 'success' : 'warn');
        activeRunId = null;
        set({ runningId: null, approvalRequest: null });
        persist();
      } catch (error) {
        updateTask({ ...task, status: 'failed', error: error instanceof Error ? error.message : 'BACKEND_AGENT_FAILED', updatedAt: new Date().toISOString() });
        appendLog(id, 'فشل تشغيل الوكيل عبر الـBackend.', 'error');
        activeRunId = null;
        set({ runningId: null, approvalRequest: null });
        persist();
      }
    },
    cancel() { cancelSignal.cancelled = true; if (activeRunId) void backendApi.cancel(activeRunId); const running = get().runningId; if (running) appendLog(running, 'تم طلب إلغاء التشغيل.', 'warn'); },
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
