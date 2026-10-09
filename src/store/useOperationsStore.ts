import { create } from 'zustand';
import { backendApi } from '../services/api/client';
import type {
  ApiSelfImproveEvent,
  ApiSelfImproveProposal,
  ApiSelfImproveSignal,
} from '../services/api/client';

/**
 * Operations console state.
 *
 * All data is read from the backend's self-improvement engine and never
 * fabricated. Mutating actions (analyze / approve / reject / rollback / monitor)
 * surface the exact backend error so an operator without the required role sees
 * the real reason instead of a silent failure.
 */
export interface OperationsState {
  signals: ApiSelfImproveSignal[];
  proposals: ApiSelfImproveProposal[];
  events: ApiSelfImproveEvent[];
  loading: boolean;
  refreshing: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
  loadedAt: string | null;
  load(mode?: 'initial' | 'refresh'): Promise<void>;
  analyze(): Promise<void>;
  monitor(): Promise<void>;
  decide(kind: 'approve' | 'reject' | 'rollback', proposalId: string, reason?: string): Promise<void>;
  clearNotice(): void;
}

export const useOperationsStore = create<OperationsState>((set, get) => ({
  signals: [],
  proposals: [],
  events: [],
  loading: false,
  refreshing: false,
  busy: null,
  error: null,
  notice: null,
  loadedAt: null,
  async load(mode = 'initial') {
    if (!backendApi.enabled) {
      set({ loading: false, refreshing: false, error: 'BACKEND_API_NOT_CONFIGURED', loadedAt: new Date().toISOString() });
      return;
    }
    set(mode === 'refresh' ? { refreshing: true, error: null } : { loading: true, error: null });
    try {
      await backendApi.requireSession();
      const [signalResult, proposalResult, historyResult] = await Promise.all([
        backendApi.getSelfImproveSignals(),
        backendApi.listSelfImproveProposals(),
        backendApi.getSelfImproveHistory(),
      ]);
      set({
        signals: signalResult.signals ?? [],
        proposals: proposalResult.proposals ?? [],
        events: historyResult.events ?? [],
        loading: false,
        refreshing: false,
        error: null,
        loadedAt: new Date().toISOString(),
      });
    } catch (error) {
      set({
        loading: false,
        refreshing: false,
        error: error instanceof Error ? error.message : 'OPERATIONS_LOAD_FAILED',
        loadedAt: new Date().toISOString(),
      });
    }
  },
  async analyze() {
    await runAction(set, get, 'analyze', () => backendApi.analyzeSelfImprove({}), 'تم تحليل الإشارات وإنشاء المقترحات.');
  },
  async monitor() {
    await runAction(set, get, 'monitor', () => backendApi.runSelfImproveMonitor(), 'تمت مراقبة المقترحات المُطبّقة والتحقق من الانحدار.');
  },
  async decide(kind, proposalId, reason) {
    const action =
      kind === 'approve'
        ? () => backendApi.approveProposal(proposalId)
        : kind === 'reject'
          ? () => backendApi.rejectProposal(proposalId, reason ?? 'rejected from operations console')
          : () => backendApi.rollbackProposal(proposalId, reason ?? 'manual rollback');
    const message =
      kind === 'approve'
        ? 'تم تطبيق المقترح وتسجيله في سجل التدقيق.'
        : kind === 'reject'
          ? 'تم رفض المقترح.'
          : 'تم التراجع عن المقترح وإلغاء تأثيره.';
    await runAction(set, get, `${kind}:${proposalId}`, action, message);
  },
  clearNotice() {
    set({ notice: null });
  },
}));

async function runAction(
  set: (partial: Partial<OperationsState>) => void,
  get: () => OperationsState,
  key: string,
  action: () => Promise<unknown>,
  successMessage: string,
): Promise<void> {
  set({ busy: key, notice: null, error: null });
  try {
    await action();
    set({ notice: successMessage });
    await get().load('refresh');
  } catch (error) {
    set({ error: error instanceof Error ? error.message : 'OPERATIONS_ACTION_FAILED' });
  } finally {
    set({ busy: null });
  }
}
