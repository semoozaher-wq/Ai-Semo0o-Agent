import { create } from 'zustand';
import { Task } from '../types/task';
import { agentExecutor, LogLevel } from '../services/agent-engine';
import { storage, STORAGE_KEYS } from '../services/storage';
import { uid } from '../utils/id';
import { DEFAULT_MODEL_ID } from '../data/models';

export interface LogEntry {
  id: string;
  message: string;
  level: LogLevel;
  at: string;
}

/** Cooperative cancellation flag for the active run. */
let cancelSignal = { cancelled: false };

interface AgentsState {
  tasks: Task[];
  logs: Record<string, LogEntry[]>;
  runningId: string | null;
  hydrated: boolean;
  hydrate(): Promise<void>;
  createTask(
    goal: string,
    opts?: { title?: string; model?: string; agentId?: string },
  ): Task;
  runTask(id: string, opts?: { model?: string }): Promise<void>;
  cancel(): void;
  removeTask(id: string): Promise<void>;
  clear(): Promise<void>;
}

export const useAgentsStore = create<AgentsState>((set, get) => {
  const persist = () => {
    void storage.set(STORAGE_KEYS.tasks, get().tasks);
  };

  const updateTask = (task: Task) => {
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === task.id ? task : t)),
    }));
  };

  return {
    tasks: [],
    logs: {},
    runningId: null,
    hydrated: false,

    async hydrate() {
      const tasks = (await storage.get<Task[]>(STORAGE_KEYS.tasks)) ?? [];
      set({ tasks, hydrated: true });
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
      const task = get().tasks.find((t) => t.id === id);
      if (!task) return;

      cancelSignal = { cancelled: false };
      set((state) => ({
        runningId: id,
        logs: { ...state.logs, [id]: [] },
      }));

      const model = opts?.model ?? task.model ?? DEFAULT_MODEL_ID;

      await agentExecutor.run(task, {
        model,
        signal: cancelSignal,
        onTaskUpdate: (updated) => {
          updateTask(updated);
        },
        onLog: (message, level) => {
          set((state) => ({
            logs: {
              ...state.logs,
              [id]: [
                ...(state.logs[id] ?? []),
                { id: uid('log'), message, level, at: new Date().toISOString() },
              ],
            },
          }));
        },
      });

      set({ runningId: null });
      persist();
    },

    cancel() {
      cancelSignal.cancelled = true;
    },

    async removeTask(id) {
      set((state) => {
        const logs = { ...state.logs };
        delete logs[id];
        return { tasks: state.tasks.filter((t) => t.id !== id), logs };
      });
      persist();
    },

    async clear() {
      set({ tasks: [], logs: {}, runningId: null });
      await storage.remove(STORAGE_KEYS.tasks);
    },
  };
});
