import { create } from 'zustand';
import { backendApi } from '../services/api/client';
import type {
  ApiCreationCapabilities,
  ApiCreationEvent,
  ApiCreationJob,
  ApiCreationJobInput,
} from '../services/api/client';

/**
 * Creation Studio state.
 *
 * One goal in, a real deliverable out. The store starts an autonomous creation
 * job on the backend and then follows it to completion, surfacing the live
 * pipeline stage, the per-iteration critic scores and the downloadable
 * artefacts (animated GIF preview, MJPEG/AVI video, composition bundle).
 *
 * Nothing is fabricated: every value comes from the backend `/creation/*` API,
 * and any failure surfaces the exact backend error.
 */

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const POLL_MS = 900;

export interface CreationState {
  capabilities: ApiCreationCapabilities | null;
  jobs: ApiCreationJob[];
  activeJob: ApiCreationJob | null;
  events: ApiCreationEvent[];
  loading: boolean;
  submitting: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
  loadedAt: string | null;
  load(): Promise<void>;
  start(input: ApiCreationJobInput): Promise<ApiCreationJob | null>;
  select(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  clearNotice(): void;
  artifactUrl(jobId: string, name: 'gif' | 'avi' | 'bundle'): string;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPolling(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

export const useCreationStore = create<CreationState>((set, get) => ({
  capabilities: null,
  jobs: [],
  activeJob: null,
  events: [],
  loading: false,
  submitting: false,
  busy: null,
  error: null,
  notice: null,
  loadedAt: null,

  async load() {
    if (!backendApi.enabled) {
      set({ loading: false, error: 'BACKEND_API_NOT_CONFIGURED', loadedAt: new Date().toISOString() });
      return;
    }
    set({ loading: true, error: null });
    try {
      await backendApi.requireSession();
      const [capabilities, jobs] = await Promise.all([
        backendApi.getCreationCapabilities(),
        backendApi.listCreationJobs(),
      ]);
      set({
        capabilities,
        jobs: jobs.jobs ?? [],
        loading: false,
        error: null,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : 'CREATION_LOAD_FAILED' });
    }
  },

  async start(input) {
    if (!backendApi.enabled) {
      set({ error: 'BACKEND_API_NOT_CONFIGURED' });
      return null;
    }
    set({ submitting: true, error: null, notice: null, events: [] });
    try {
      await backendApi.requireSession();
      const job = await backendApi.startCreationJob(input);
      set({ submitting: false, activeJob: job, notice: 'CREATION_STARTED' });
      get().select(job.id);
      return job;
    } catch (error) {
      set({ submitting: false, error: error instanceof Error ? error.message : 'CREATION_START_FAILED' });
      return null;
    }
  },

  async select(jobId) {
    stopPolling();
    try {
      const [job, eventResult] = await Promise.all([
        backendApi.getCreationJob(jobId),
        backendApi.getCreationEvents(jobId, 0).catch(() => ({ jobId, status: 'unknown', events: [] as ApiCreationEvent[] })),
      ]);
      set({ activeJob: job, events: eventResult.events ?? [], error: null });
      if (!TERMINAL.has(job.status)) {
        pollTimer = setTimeout(() => { void get().select(jobId); }, POLL_MS);
      } else {
        // Refresh the list once a job finishes so statuses stay accurate.
        void backendApi.listCreationJobs().then((result) => set({ jobs: result.jobs ?? [] })).catch(() => {});
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'CREATION_JOB_LOAD_FAILED' });
    }
  },

  async cancel(jobId) {
    set({ busy: jobId });
    try {
      const job = await backendApi.cancelCreationJob(jobId);
      set({ busy: null, activeJob: job, notice: 'CREATION_CANCELLED' });
    } catch (error) {
      set({ busy: null, error: error instanceof Error ? error.message : 'CREATION_CANCEL_FAILED' });
    }
  },

  clearNotice() {
    set({ notice: null });
  },

  artifactUrl(jobId, name) {
    return backendApi.creationArtifactUrl(jobId, name);
  },
}));
