import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { resolveBackendUrl } from './backend-url';
import { consumeSse } from './sse';
import { createAccountApi } from '../account/api';
import type {
  ApiAccount,
  ApiAccountDeletion,
  ApiAccountExport,
  ApiMfaSetup,
  DeleteAccountInput,
} from '../account/api';

export interface ApiUser { id: string; tenantId: string; email: string; role: string }
export interface ApiSession { token: string; expiresAt: string }
export interface ApiProject { projectId: string; workspaceId: string }
export interface ApiRun { runId: string; taskId: string; status: string }
export interface ApiRunSnapshot { status: string; result?: { final?: string; outputs?: unknown[]; error?: string } | null; events?: { type: string; payload_json: string }[]; usage?: unknown[] }
export interface ApiChatResponse { text: string; provider: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
export interface ApiChatStreamFrame {
  type: string;
  text?: string;
  conversationId?: string;
  userMessageId?: string;
  assistantMessageId?: string;
  provider?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  error?: string;
  chars?: number;
  [key: string]: unknown;
}
export interface ApiChatConversation { id: string; title: string; mode: string; status: string; project_id?: string | null; last_message_at?: string | null; created_at: string; updated_at: string }
export interface ApiRecoverableConversation { conversationId: string; title: string; interrupted: number }
export interface ApiEvent { type: string; at?: string; stepId?: string; toolId?: string; approvalId?: string; title?: string; reason?: string; final?: string; steps?: number; details?: Record<string, unknown>; [key: string]: unknown }
export interface ApiUsagePoint { date: string; tokens: number; costUsd: number; runs: number; messages: number }
export interface ApiUsageSummary {
  period: string;
  days: number;
  quota: { monthly_tokens: number; monthly_runs: number };
  counter: { tokens: number; runs: number };
  daily: ApiUsagePoint[];
  totals: { tokens: number; costUsd: number; runs: number; messages: number };
  generatedAt: string;
}
export interface ApiToolStatusSummary { live: number; partial: number; unwired: number; catalogOnly: number; simulated: number; failed: number; dangerous: number }
export interface ApiToolDetail { id: string; state: string; reason: string | null }
export interface ApiToolsStatus {
  live: string[];
  partial: string[];
  catalogOnly: string[];
  simulated: string[];
  unwired: string[];
  failed: string[];
  dangerous: string[];
  tools?: ApiToolDetail[];
  summary?: ApiToolStatusSummary;
}
export interface ApiModelProvider { id?: string; name?: string; configured: boolean; healthy?: boolean; [key: string]: unknown }
export interface ApiModelsStatus { providers: ApiModelProvider[] }
export interface ApiBillingStatus { plan?: string; provider?: string; configured?: boolean; [key: string]: unknown }
export interface ApiConnectorStatus {
  configured: boolean;
  provider?: string | null;
  model?: string | null;
  host?: string | null;
  reason?: string | null;
  error?: string | null;
  [key: string]: unknown;
}
export interface ApiGitHubConnection {
  id: string;
  login: string | null;
  scope: string | null;
  provider: string;
  updated_at: string;
}
export interface ApiGitHubStatus extends ApiConnectorStatus {
  tokenConfigured: boolean;
  oauthConfigured: boolean;
  connection: ApiGitHubConnection | null;
}
export interface ApiIntegrationsStatus {
  tools: { live: string[]; partial: string[]; unwired: string[]; failed: string[] };
  billing: ApiConnectorStatus;
  github: ApiGitHubStatus;
  embeddings: ApiConnectorStatus;
  errorTracking: ApiConnectorStatus;
  browser: { cdpConfigured: boolean; localLaunch: boolean };
}
export interface ApiReadinessCheck { ok: boolean; configured?: boolean; [key: string]: unknown }
export interface ApiReadyReport {
  ok: boolean;
  version?: string;
  checks?: {
    database?: ApiReadinessCheck;
    workspace?: ApiReadinessCheck;
    providers?: ApiReadinessCheck & { configured?: number; total?: number };
  };
  providers?: ApiModelProvider[];
}
export interface ApiHealth { ok: boolean; service: string; version?: string; uptimeSeconds?: number; time: string }

// --- Code intelligence & capability benchmarking -----------------------------
// Read-only views over the project index. Shapes mirror the backend routes
// (`/codebase/*`, `/capabilities/scorecard`, `/benchmark/agent`) exactly.
export interface ApiCodeIntelligenceSummary {
  generatedAt: string;
  root: string;
  parser: string;
  truncated: boolean;
  counts: { files: number; symbols: number; imports: number; edges: number; tests: number };
  sample?: { files: string[]; symbols: unknown[]; edges: unknown[] };
  intelligence?: unknown;
}
export interface ApiRiskFactor { name: string; value: number; weight: number }
export interface ApiImpactAnalysis {
  changedFiles: string[];
  directDependents: string[];
  blastRadius: string[];
  affectedFiles: string[];
  affectedTests: string[];
  affectedSymbols: unknown[];
  depth: Record<string, number>;
  risk: { score: number; level: string; factors: ApiRiskFactor[] };
  truncated: boolean;
  description: string;
}
export interface ApiChangeSet {
  id: string;
  generatedAt: string;
  goal: string | null;
  summary: { files: number; additions: number; deletions: number; [key: string]: unknown };
  changes: unknown[];
  impact: ApiImpactAnalysis | null;
  verification: unknown;
  risk: { score: number; level: string; factors: ApiRiskFactor[] };
  description: string;
}
export interface ApiCapabilityEntry { id: string; name: string; weight: number; status: string; score: number; evidence: string[] }
export interface ApiCapabilityScorecard {
  generatedAt: string;
  score: number;
  provenScore: number;
  level: string;
  models: { configured: number; healthy: number; total: number };
  integrations: { configured: string[]; total: number };
  capabilities: ApiCapabilityEntry[];
  summary: { total: number; proven: number; wired: number; partial: number; unwired: number; failed: number };
  description: string;
}
export interface ApiBenchmarkTask {
  id: string;
  name: string;
  ok: boolean;
  score: number;
  durationMs: number;
  evaluators: { id: string; passed: boolean; detail: string | null }[];
}
export interface ApiBenchmarkReport {
  name: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tasks: ApiBenchmarkTask[];
  summary: { total: number; passed: number; failed: number; passRate: number; score: number; byEvaluator: Record<string, { passed: number; failed: number; rate: number }> };
  workspace?: { root: string | null; files: number; symbols: number };
}
export interface ApiReasoningResult { mode?: string; [key: string]: unknown }

export interface ApiMember { userId: string; email: string; role: string; status: string; joinedAt: string }
export interface ApiInvitation { invitationId: string; email: string; role: string; expiresAt: string; acceptedAt: string | null; createdAt: string; invitedByEmail?: string | null }
export interface ApiSelfImproveSample { toolId?: string; error?: string; runId?: string; at?: string }
export interface ApiSelfImproveSignal { signature: string; category: string; occurrences: number; samples: ApiSelfImproveSample[] }
export interface ApiSelfImprovePatch { kind: string; toolId?: string; target?: string; hint?: string; note?: string; maxAttempts?: number; [key: string]: unknown }
export interface ApiSelfImproveProposal {
  id: string;
  tenantId: string;
  scope: string;
  signature: string;
  category: string;
  kind: string;
  status: string;
  severity: string;
  title: string;
  rationale: string;
  patch: ApiSelfImprovePatch;
  evidence: { occurrences?: number; windowHours?: number; samples?: ApiSelfImproveSample[]; [key: string]: unknown };
  regression: Record<string, unknown> | null;
  occurrences: number;
  createdBy: string;
  decidedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt?: string | null;
  rolledBackAt?: string | null;
}
export interface ApiSelfImproveEvent { id: string; proposalId: string | null; phase: string; detail: Record<string, unknown>; createdAt: string }
export interface ApiOutboxEmail { id: string; to: string; template: string; subject: string; status: string; attempts: number; error: string | null; createdAt: string; sentAt: string | null }
export interface ApiOutboxResponse { providerConfigured: boolean; emails: ApiOutboxEmail[] }

// --- Creation Studio ---------------------------------------------------------
// One goal in, a real deliverable out. Mirrors the `/creation/*` backend routes.
export interface ApiCreationCapabilities {
  kernel: boolean;
  localStudio: boolean;
  providers: { image: boolean; vision: boolean; tts: boolean; video: boolean; music: boolean; mediaAnalysis: boolean };
  formats: string[];
  resolutions: string[];
}
export interface ApiCreationBrief {
  goal: string; title: string; logline: string; type: string; tone: string; mood: string;
  audience: string; language: string; format: string; width: number; height: number; fps: number;
  duration: number; palette: string; paletteColors: { background: string; accent: string; secondary: string; text: string; muted: string };
  keywords: string[]; keyMessages: string[]; cta: string; captions: boolean; voiceover: boolean; musicMood: string;
  aspect: string; slug: string; source: string;
}
export interface ApiCreationScene { id: string; purpose: string; role: string; headline: string; subhead: string; duration: number; camera: string; transitionIn: string; caption: string; accent: string }
export interface ApiCreationStoryboard { scenes: ApiCreationScene[]; source: string }
export interface ApiCreationCritique { score: number; subscores: Record<string, number>; issues: { severity: string; area: string; message: string }[]; directives: { area: string; action: string; detail: string }[]; source: string }
export interface ApiCreationManifest {
  title: string; goal: string; width: number; height: number; fps: number; duration: number; frameCount: number;
  hasAudio: boolean; formats: string[]; score: number; iterations: number;
  providers: { image: boolean; vision: boolean; tts: boolean; video: boolean; music: boolean; mediaAnalysis: boolean };
  generatedAt: string; elapsedMs: number;
}
export interface ApiCreationArtifact { bytes: number; mimeType: string }
export interface ApiCreationJob {
  id: string; goal: string; status: string; createdAt: string; updatedAt: string; elapsedMs: number;
  progress: { stage: string; done: number; total: number };
  error: string | null;
  result: null | {
    brief: ApiCreationBrief; storyboard: ApiCreationStoryboard; bibles: unknown; timeline: unknown;
    critique: ApiCreationCritique; iterations: { iteration: number; score: number; subscores: Record<string, number> }[];
    manifest: ApiCreationManifest; assets: string[];
  };
  artifacts: { gif: ApiCreationArtifact | null; avi: ApiCreationArtifact | null; bundle: ApiCreationArtifact | null };
}
export interface ApiCreationEvent { seq: number; type: string; payload: Record<string, unknown>; at: string }
export interface ApiCreationPlan { brief: ApiCreationBrief; storyboard: ApiCreationStoryboard; bibles: unknown; prompts: unknown[]; elapsedMs: number }
export interface ApiCreationJobInput {
  goal: string;
  format?: 'landscape' | 'portrait' | 'square' | 'wide';
  duration?: number;
  palette?: string;
  resolution?: 'draft' | 'standard' | 'high' | 'full';
  fps?: number;
  bundle?: boolean;
  model?: string;
}

const SESSION_STORAGE_KEY = 'semo0o.backend.session';

/**
 * Session token persistence. The token (never the password) is kept so a
 * returning, already-authorised user stays signed in across reloads. Web uses
 * localStorage; native uses the OS keychain via SecureStore.
 */
async function readStoredToken(): Promise<string | null> {
  try {
    if (Platform.OS === 'web') return globalThis.localStorage?.getItem(SESSION_STORAGE_KEY) ?? null;
    return await SecureStore.getItemAsync(SESSION_STORAGE_KEY);
  } catch { return null; }
}
async function writeStoredToken(token: string | null): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      if (token) globalThis.localStorage?.setItem(SESSION_STORAGE_KEY, token);
      else globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY);
      return;
    }
    if (token) await SecureStore.setItemAsync(SESSION_STORAGE_KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    else await SecureStore.deleteItemAsync(SESSION_STORAGE_KEY);
  } catch { /* keep the in-memory session if secure persistence is unavailable */ }
}

class BackendApiClient {
  private token: string | null = null;
  private user: ApiUser | null = null;
  constructor(private readonly baseUrl = resolveBackendUrl()) {}
  get enabled(): boolean { return Boolean(this.baseUrl); }
  get currentUser(): ApiUser | null { return this.user; }
  get authenticated(): boolean { return Boolean(this.token && this.user); }
  setSession(session: ApiSession | null, user?: ApiUser): void {
    this.token = session?.token ?? null;
    if (user) this.user = user;
    void writeStoredToken(this.token);
  }
  clearSession(): void { this.token = null; this.user = null; void writeStoredToken(null); }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.enabled) throw new Error('BACKEND_API_NOT_CONFIGURED');
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(init.headers ?? {}) },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(payload.error ?? `BACKEND_${response.status}`));
    return payload as T;
  }
  private async requestTolerant<T>(path: string): Promise<{ status: number; body: T }> {
    if (!this.enabled) throw new Error('BACKEND_API_NOT_CONFIGURED');
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body: body as T };
  }
  /**
   * Cold-start session restore. Loads the persisted token and validates it
   * against the server (`GET /auth/session`). Returns the user for a live
   * session, or null when there is none/expired. NEVER creates an account —
   * the previous device auto-registration backdoor is gone.
   */
  async restoreSession(): Promise<ApiUser | null> {
    if (this.token && this.user) return this.user;
    const stored = await readStoredToken();
    if (!stored) return null;
    this.token = stored;
    try {
      const { user } = await this.request<{ user: ApiUser }>('/auth/session');
      this.user = user;
      return user;
    } catch {
      this.clearSession();
      return null;
    }
  }
  /** Returns the authenticated user or throws AUTH_REQUIRED (gate enforcement). */
  async requireSession(): Promise<ApiUser> {
    if (this.token && this.user) return this.user;
    const restored = await this.restoreSession();
    if (!restored) throw new Error('AUTH_REQUIRED');
    return restored;
  }
  /** Secret-free view of the deployment's enrolment gate (access key, open sign-up). */
  async getAccessPolicy(): Promise<{ private: boolean; registration: { open: boolean; requiresAccessKey: boolean; requiresEmailVerification: boolean } }> {
    return this.request('/auth/policy');
  }
  async register(input: { email: string; password: string; tenantName?: string; accessKey?: string }): Promise<{ user: ApiUser; session: ApiSession | null; verificationRequired?: boolean }> {
    const value = await this.request<{ user: ApiUser; session: ApiSession | null; verificationRequired?: boolean }>('/auth/register', { method: 'POST', body: JSON.stringify(input) });
    if (value.session) this.setSession(value.session, value.user);
    return value;
  }
  async login(input: { email: string; password: string; mfaCode?: string }): Promise<{ user: ApiUser; session: ApiSession }> { const value = await this.request<{ user: ApiUser; session: ApiSession }>('/auth/login', { method: 'POST', body: JSON.stringify(input) }); this.setSession(value.session, value.user); return value; }
  async logout(): Promise<void> { await this.request('/auth/logout', { method: 'POST' }); this.clearSession(); }
  async verifyEmail(token: string): Promise<Record<string, unknown>> { return this.request('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }); }
  async requestPasswordReset(email: string): Promise<Record<string, unknown>> { return this.request('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) }); }
  async resetPassword(token: string, password: string): Promise<Record<string, unknown>> { return this.request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }); }
  // Account endpoints (profile, MFA, data export, deletion) are defined ONCE in
  // ../account/api and bound to this client's authenticated transport here, so
  // the wire contract is shared and independently testable.
  private get account() {
    return createAccountApi(<T>(path: string, init?: RequestInit) => this.request<T>(path, init));
  }
  async getAccount(): Promise<ApiAccount> { return this.account.getAccount(); }
  async setupMfa(): Promise<ApiMfaSetup> { return this.account.setupMfa(); }
  async confirmMfa(code: string): Promise<{ enabled: boolean }> { return this.account.confirmMfa(code); }
  async deleteAccount(input: DeleteAccountInput): Promise<ApiAccountDeletion> { return this.account.deleteAccount(input); }
  async exportAccount(): Promise<ApiAccountExport> { return this.account.exportAccount(); }
  async inviteMember(email: string, role: 'admin' | 'member' | 'viewer' = 'member'): Promise<{ invitationId: string; expiresAt: string; delivery: string }> { return this.request('/org/invitations', { method: 'POST', body: JSON.stringify({ email, role }) }); }
  async acceptInvitation(token: string): Promise<Record<string, unknown>> { return this.request('/org/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }); }
  async listMembers(): Promise<{ members: ApiMember[] }> { return this.request<{ members: ApiMember[] }>('/org/members'); }
  async updateMemberRole(userId: string, role: 'admin' | 'member' | 'viewer'): Promise<{ member: { userId: string; role: string; status: string } }> { return this.request(`/org/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ role }) }); }
  async removeMember(userId: string): Promise<Record<string, unknown>> { return this.request(`/org/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }); }
  async listInvitations(): Promise<{ invitations: ApiInvitation[] }> { return this.request<{ invitations: ApiInvitation[] }>('/org/invitations'); }
  async revokeInvitation(invitationId: string): Promise<Record<string, unknown>> { return this.request(`/org/invitations/${encodeURIComponent(invitationId)}`, { method: 'DELETE' }); }
  async createProject(input: { name: string; rootPath?: string }): Promise<ApiProject> { return this.request<ApiProject>('/projects', { method: 'POST', body: JSON.stringify(input) }); }
  async chat(input: { message: string; model?: string }): Promise<ApiChatResponse> { return this.request<ApiChatResponse>('/chat', { method: 'POST', body: JSON.stringify(input) }); }
  // Streams a chat reply over Server-Sent Events. Each `event:`/`data:` pair is
  // normalised into an `ApiChatStreamFrame` (`start` | `token` | `done` | `error`).
  // The caller accumulates `token` frames; `start` carries the durable
  // conversation/assistant ids so the client can reconcile after a reload.
  async chatStream(
    input: { message: string; model?: string; conversationId?: string },
    onFrame: (frame: ApiChatStreamFrame) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.enabled) throw new Error('BACKEND_API_NOT_CONFIGURED');
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal }),
    });
    await consumeSse(response, ({ event, data }) => {
      onFrame({ type: event, ...(data as Record<string, unknown>) } as ApiChatStreamFrame);
    });
  }
  async listConversations(): Promise<{ conversations: ApiChatConversation[] }> { return this.request<{ conversations: ApiChatConversation[] }>('/conversations'); }
  async getRecoverableChats(): Promise<{ conversations: ApiRecoverableConversation[] }> { return this.request<{ conversations: ApiRecoverableConversation[] }>('/chat/recoverable'); }
  async recoverChat(conversationId: string): Promise<{ recovered: { id: string; conversationId: string; content: string }[] }> { return this.request(`/conversations/${encodeURIComponent(conversationId)}/recover`, { method: 'POST' }); }
  async createRun(input: Record<string, unknown>): Promise<ApiRun> { return this.request<ApiRun>('/runs', { method: 'POST', body: JSON.stringify(input) }); }
  async getRun(runId: string): Promise<ApiRunSnapshot> { return this.request<ApiRunSnapshot>(`/runs/${encodeURIComponent(runId)}`); }
  async getUsage(days = 30): Promise<ApiUsageSummary> { return this.request<ApiUsageSummary>(`/usage?days=${encodeURIComponent(String(days))}`); }
  async getToolsStatus(): Promise<ApiToolsStatus> { return this.request<ApiToolsStatus>('/tools/status'); }
  async getModelsStatus(): Promise<ApiModelsStatus> { return this.request<ApiModelsStatus>('/models/status'); }
  async getBillingStatus(): Promise<ApiBillingStatus> { return this.request<ApiBillingStatus>('/billing/status'); }
  // Honest connector state from the backend: every optional integration
  // (GitHub, billing, embeddings, error tracking, browser) with its real
  // configured/unwired state — never a fabricated success.
  async getIntegrationsStatus(): Promise<ApiIntegrationsStatus> { return this.request<ApiIntegrationsStatus>('/integrations/status'); }
  // --- Code intelligence (read-only views over the project index) ----------
  async getCodebaseIntelligence(projectId: string, options: { maxFiles?: number; full?: boolean } = {}): Promise<ApiCodeIntelligenceSummary> {
    const params = new URLSearchParams({ projectId });
    if (options.maxFiles) params.set('maxFiles', String(options.maxFiles));
    if (options.full) params.set('full', '1');
    return this.request<ApiCodeIntelligenceSummary>(`/codebase/intelligence?${params.toString()}`);
  }
  async analyzeImpact(input: { projectId: string; changedFiles: string[]; maxDepth?: number }): Promise<ApiImpactAnalysis> { return this.request<ApiImpactAnalysis>('/codebase/impact', { method: 'POST', body: JSON.stringify(input) }); }
  async reasonCodebase(input: { projectId: string; question: string; mode?: 'auto' | 'definition' | 'references' | 'trace' | 'explain' | 'search'; target?: string; from?: string; to?: string }): Promise<ApiReasoningResult> { return this.request<ApiReasoningResult>('/codebase/reason', { method: 'POST', body: JSON.stringify(input) }); }
  async buildChangeSet(input: { projectId: string; goal?: string }): Promise<ApiChangeSet> { return this.request<ApiChangeSet>('/codebase/changeset', { method: 'POST', body: JSON.stringify(input) }); }
  // --- Capability benchmarking ---------------------------------------------
  async getCapabilityScorecard(): Promise<ApiCapabilityScorecard> { return this.request<ApiCapabilityScorecard>('/capabilities/scorecard'); }
  async runAgentBenchmark(projectId: string): Promise<ApiBenchmarkReport> { return this.request<ApiBenchmarkReport>('/benchmark/agent', { method: 'POST', body: JSON.stringify({ projectId }) }); }
  // GitHub OAuth connect flow. `start` returns the authorize URL + single-use
  // state; `complete` exchanges the pasted code for a stored (encrypted) token;
  // `disconnect` removes the tenant's stored connection. All three surface the
  // exact backend error (e.g. GITHUB_OAUTH_NOT_CONFIGURED) when unavailable.
  async startGitHubOAuth(): Promise<{ url: string; state: string }> { return this.request<{ url: string; state: string }>('/github/oauth/start', { method: 'POST' }); }
  async completeGitHubOAuth(input: { state: string; code: string }): Promise<{ connected: boolean; login: string; scope: string | null }> { return this.request<{ connected: boolean; login: string; scope: string | null }>('/github/oauth/complete', { method: 'POST', body: JSON.stringify(input) }); }
  async disconnectGitHub(): Promise<{ disconnected: boolean; removed: number }> { return this.request<{ disconnected: boolean; removed: number }>('/github/connection', { method: 'DELETE' }); }
  async getHealth(): Promise<ApiHealth> { return this.request<ApiHealth>('/health'); }
  async getReady(): Promise<{ status: number; report: ApiReadyReport }> { const { status, body } = await this.requestTolerant<ApiReadyReport>('/ready'); return { status, report: body }; }
  async getSelfImproveSignals(windowHours = 168): Promise<{ signals: ApiSelfImproveSignal[]; windowHours: number }> { return this.request(`/self-improve/signals?windowHours=${encodeURIComponent(String(windowHours))}`); }
  async analyzeSelfImprove(input: { windowHours?: number; minOccurrences?: number } = {}): Promise<{ signals: ApiSelfImproveSignal[]; proposals: ApiSelfImproveProposal[] }> { return this.request('/self-improve/analyze', { method: 'POST', body: JSON.stringify(input) }); }
  async listSelfImproveProposals(status?: string): Promise<{ proposals: ApiSelfImproveProposal[] }> { const query = status ? `?status=${encodeURIComponent(status)}` : ''; return this.request<{ proposals: ApiSelfImproveProposal[] }>(`/self-improve/proposals${query}`); }
  async getSelfImproveProposal(proposalId: string): Promise<{ proposal: ApiSelfImproveProposal; events: ApiSelfImproveEvent[] }> { return this.request(`/self-improve/proposals/${encodeURIComponent(proposalId)}`); }
  async approveProposal(proposalId: string): Promise<{ proposal: ApiSelfImproveProposal }> { return this.request(`/self-improve/proposals/${encodeURIComponent(proposalId)}/approve`, { method: 'POST' }); }
  async rejectProposal(proposalId: string, reason = ''): Promise<{ proposal: ApiSelfImproveProposal }> { return this.request(`/self-improve/proposals/${encodeURIComponent(proposalId)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); }
  async rollbackProposal(proposalId: string, reason = 'manual rollback'): Promise<{ proposal: ApiSelfImproveProposal }> { return this.request(`/self-improve/proposals/${encodeURIComponent(proposalId)}/rollback`, { method: 'POST', body: JSON.stringify({ reason }) }); }
  async runSelfImproveMonitor(): Promise<{ checked: { proposalId: string; signature: string; occurrences: number; regressed: boolean }[]; rolledBack: ApiSelfImproveProposal[] }> { return this.request('/self-improve/monitor', { method: 'POST' }); }
  async getSelfImproveHistory(): Promise<{ events: ApiSelfImproveEvent[] }> { return this.request<{ events: ApiSelfImproveEvent[] }>('/self-improve/history'); }
  async getOutbox(status?: string): Promise<ApiOutboxResponse> { const query = status ? `?status=${encodeURIComponent(status)}` : ''; return this.request<ApiOutboxResponse>(`/notifications/outbox${query}`); }
  async processOutbox(): Promise<{ providerConfigured: boolean; provider?: string; processed: number; sent: number; failed: number; queued: number }> { return this.request('/notifications/outbox/process', { method: 'POST' }); }
  async runRetention(): Promise<Record<string, unknown>> { return this.request('/ops/retention/run', { method: 'POST' }); }
  async approve(runId: string, decision: 'allow' | 'deny' | 'cancel'): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body: JSON.stringify({ decision }) }); }
  async cancel(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }); }
  async retry(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST' }); }
  async pause(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/pause`, { method: 'POST' }); }
  async resume(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' }); }
  async streamEvents(runId: string, onEvent: (event: ApiEvent) => void, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}/events`, { headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, ...(signal === undefined ? {} : { signal }) });
    await consumeSse(response, ({ data }) => onEvent(data as ApiEvent));
  }
  // --- Creation Studio -----------------------------------------------------
  async getCreationCapabilities(): Promise<ApiCreationCapabilities> { return this.request<ApiCreationCapabilities>('/creation/capabilities'); }
  async startCreationJob(input: ApiCreationJobInput): Promise<ApiCreationJob> { return this.request<ApiCreationJob>('/creation/jobs', { method: 'POST', body: JSON.stringify(input) }); }
  async listCreationJobs(): Promise<{ jobs: ApiCreationJob[] }> { return this.request<{ jobs: ApiCreationJob[] }>('/creation/jobs'); }
  async getCreationJob(id: string): Promise<ApiCreationJob> { return this.request<ApiCreationJob>(`/creation/jobs/${encodeURIComponent(id)}`); }
  async getCreationEvents(id: string, since = 0): Promise<{ jobId: string; status: string; events: ApiCreationEvent[] }> {
    return this.request(`/creation/jobs/${encodeURIComponent(id)}/events?since=${encodeURIComponent(String(since))}`);
  }
  async cancelCreationJob(id: string): Promise<ApiCreationJob> { return this.request<ApiCreationJob>(`/creation/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }); }
  async planCreation(input: ApiCreationJobInput): Promise<ApiCreationPlan> { return this.request<ApiCreationPlan>('/creation/plan', { method: 'POST', body: JSON.stringify(input) }); }
  /** Public (token-free) URL for a job artefact, so it can be opened/downloaded directly. */
  creationArtifactUrl(id: string, name: 'gif' | 'avi' | 'bundle'): string {
    return `${this.baseUrl.replace(/\/$/, '')}/creation/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`;
  }
  async streamCreationEvents(id: string, onEvent: (event: ApiCreationEvent) => void, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/creation/jobs/${encodeURIComponent(id)}/events`, { headers: { accept: 'text/event-stream', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, ...(signal === undefined ? {} : { signal }) });
    await consumeSse(response, ({ data }) => onEvent(data as ApiCreationEvent));
  }
}

export const backendApi = new BackendApiClient();
export { BackendApiClient };
export type { ApiAccount, ApiAccountDeletion, ApiAccountExport, ApiMfaSetup, DeleteAccountInput } from '../account/api';
