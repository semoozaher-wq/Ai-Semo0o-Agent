import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

export interface ApiUser { id: string; tenantId: string; email: string; role: string }
export interface ApiSession { token: string; expiresAt: string }
export interface ApiProject { projectId: string; workspaceId: string }
export interface ApiRun { runId: string; taskId: string; status: string }
export interface ApiRunSnapshot { status: string; result?: { final?: string; outputs?: unknown[]; error?: string } | null; events?: { type: string; payload_json: string }[]; usage?: unknown[] }
export interface ApiChatResponse { text: string; provider: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }
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
export interface ApiToolStatusSummary { live: number; unwired: number; catalogOnly: number; simulated: number; dangerous: number }
export interface ApiToolsStatus {
  live: string[];
  catalogOnly: string[];
  simulated: string[];
  unwired: string[];
  dangerous: string[];
  summary?: ApiToolStatusSummary;
}
export interface ApiModelProvider { id?: string; name?: string; configured: boolean; healthy?: boolean; [key: string]: unknown }
export interface ApiModelsStatus { providers: ApiModelProvider[] }
export interface ApiBillingStatus { plan?: string; provider?: string; configured?: boolean; [key: string]: unknown }
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

type StoredBootstrap = { email: string; password: string };

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

class BackendApiClient {
  private token: string | null = null;
  private user: ApiUser | null = null;
  constructor(private readonly baseUrl = (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_BACKEND_URL) || '') {}
  get enabled(): boolean { return Boolean(this.baseUrl); }
  setSession(session: ApiSession | null, user?: ApiUser): void { this.token = session?.token ?? null; if (user) this.user = user; }
  clearSession(): void { this.token = null; this.user = null; }
  private async storedCredentials(): Promise<StoredBootstrap | null> {
    try {
      const raw = Platform.OS === 'web'
        ? globalThis.sessionStorage?.getItem('semo0o.backend.bootstrap')
        : await SecureStore.getItemAsync('semo0o.backend.bootstrap');
      return raw ? JSON.parse(raw) as StoredBootstrap : null;
    } catch { return null; }
  }
  private async saveCredentials(value: StoredBootstrap): Promise<void> {
    try {
      const raw = JSON.stringify(value);
      if (Platform.OS === 'web') globalThis.sessionStorage?.setItem('semo0o.backend.bootstrap', raw);
      else await SecureStore.setItemAsync('semo0o.backend.bootstrap', raw, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    } catch { /* keep an in-memory session if secure persistence is unavailable */ }
  }
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
  async ensureSession(): Promise<ApiUser> {
    if (this.token && this.user) return this.user;
    const configured: StoredBootstrap | null = typeof process !== 'undefined' && process.env.EXPO_PUBLIC_AGENT_EMAIL && process.env.EXPO_PUBLIC_AGENT_PASSWORD
      ? { email: process.env.EXPO_PUBLIC_AGENT_EMAIL, password: process.env.EXPO_PUBLIC_AGENT_PASSWORD }
      : null;
    const saved = configured ?? await this.storedCredentials();
    const credentials = saved ?? { email: `device-${randomSecret().slice(0, 16)}@local.semo0o`, password: randomSecret() };
    try {
      const registered = await this.register({ ...credentials, tenantName: 'Semo0o Device Workspace' });
      this.user = registered.user;
      await this.saveCredentials(credentials);
      return registered.user;
    } catch (error) {
      if (!String(error).includes('already') && !String(error).includes('UNIQUE')) throw error;
      const loggedIn = await this.login(credentials);
      this.user = loggedIn.user;
      return loggedIn.user;
    }
  }
  async register(input: { email: string; password: string; tenantName?: string }): Promise<{ user: ApiUser; session: ApiSession }> { const value = await this.request<{ user: ApiUser; session: ApiSession }>('/auth/register', { method: 'POST', body: JSON.stringify(input) }); this.setSession(value.session, value.user); return value; }
  async login(input: { email: string; password: string; mfaCode?: string }): Promise<{ user: ApiUser; session: ApiSession }> { const value = await this.request<{ user: ApiUser; session: ApiSession }>('/auth/login', { method: 'POST', body: JSON.stringify(input) }); this.setSession(value.session, value.user); return value; }
  async logout(): Promise<void> { await this.request('/auth/logout', { method: 'POST' }); this.clearSession(); }
  async verifyEmail(token: string): Promise<Record<string, unknown>> { return this.request('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) }); }
  async requestPasswordReset(email: string): Promise<Record<string, unknown>> { return this.request('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) }); }
  async resetPassword(token: string, password: string): Promise<Record<string, unknown>> { return this.request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }); }
  async setupMfa(): Promise<{ secret: string; enabled: boolean }> { return this.request('/auth/mfa/setup', { method: 'POST' }); }
  async confirmMfa(code: string): Promise<{ enabled: boolean }> { return this.request('/auth/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) }); }
  async inviteMember(email: string, role: 'admin' | 'member' | 'viewer' = 'member'): Promise<{ invitationId: string; expiresAt: string; delivery: string }> { return this.request('/org/invitations', { method: 'POST', body: JSON.stringify({ email, role }) }); }
  async acceptInvitation(token: string): Promise<Record<string, unknown>> { return this.request('/org/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }); }
  async createProject(input: { name: string; rootPath?: string }): Promise<ApiProject> { return this.request<ApiProject>('/projects', { method: 'POST', body: JSON.stringify(input) }); }
  async chat(input: { message: string; model?: string }): Promise<ApiChatResponse> { return this.request<ApiChatResponse>('/chat', { method: 'POST', body: JSON.stringify(input) }); }
  async createRun(input: Record<string, unknown>): Promise<ApiRun> { return this.request<ApiRun>('/runs', { method: 'POST', body: JSON.stringify(input) }); }
  async getRun(runId: string): Promise<ApiRunSnapshot> { return this.request<ApiRunSnapshot>(`/runs/${encodeURIComponent(runId)}`); }
  async getUsage(days = 30): Promise<ApiUsageSummary> { return this.request<ApiUsageSummary>(`/usage?days=${encodeURIComponent(String(days))}`); }
  async getToolsStatus(): Promise<ApiToolsStatus> { return this.request<ApiToolsStatus>('/tools/status'); }
  async getModelsStatus(): Promise<ApiModelsStatus> { return this.request<ApiModelsStatus>('/models/status'); }
  async getBillingStatus(): Promise<ApiBillingStatus> { return this.request<ApiBillingStatus>('/billing/status'); }
  async getHealth(): Promise<ApiHealth> { return this.request<ApiHealth>('/health'); }
  async getReady(): Promise<{ status: number; report: ApiReadyReport }> { const { status, body } = await this.requestTolerant<ApiReadyReport>('/ready'); return { status, report: body }; }
  async approve(runId: string, decision: 'allow' | 'deny' | 'cancel'): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body: JSON.stringify({ decision }) }); }
  async cancel(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }); }
  async retry(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/retry`, { method: 'POST' }); }
  async pause(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/pause`, { method: 'POST' }); }
  async resume(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST' }); }
  async streamEvents(runId: string, onEvent: (event: ApiEvent) => void, signal?: AbortSignal): Promise<void> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}/events`, { headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) }, signal });
    if (!response.ok || !response.body) throw new Error(`BACKEND_SSE_${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const chunks = buffer.split('\n\n'); buffer = chunks.pop() ?? '';
      for (const chunk of chunks) {
        const data = chunk.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
        if (data) { try { onEvent(JSON.parse(data) as ApiEvent); } catch { /* ignore malformed event */ } }
      }
    }
  }
}

export const backendApi = new BackendApiClient();
export { BackendApiClient };
