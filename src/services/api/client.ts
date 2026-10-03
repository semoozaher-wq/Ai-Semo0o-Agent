export interface ApiUser { id: string; tenantId: string; email: string; role: string }
export interface ApiSession { token: string; expiresAt: string }
export interface ApiProject { projectId: string; workspaceId: string }
export interface ApiRun { runId: string; taskId: string; status: string }

class BackendApiClient {
  private token: string | null = null;
  constructor(private readonly baseUrl = (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_BACKEND_URL) || '') {}
  get enabled(): boolean { return Boolean(this.baseUrl); }
  setSession(session: ApiSession | null): void { this.token = session?.token ?? null; }
  clearSession(): void { this.token = null; }
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
  async register(input: { email: string; password: string; tenantName?: string }): Promise<{ user: ApiUser; session: ApiSession }> { const value = await this.request<{ user: ApiUser; session: ApiSession }>('/auth/register', { method: 'POST', body: JSON.stringify(input) }); this.setSession(value.session); return value; }
  async login(input: { email: string; password: string }): Promise<{ user: ApiUser; session: ApiSession }> { const value = await this.request<{ user: ApiUser; session: ApiSession }>('/auth/login', { method: 'POST', body: JSON.stringify(input) }); this.setSession(value.session); return value; }
  async logout(): Promise<void> { await this.request('/auth/logout', { method: 'POST' }); this.clearSession(); }
  async createProject(input: { name: string; rootPath?: string }): Promise<ApiProject> { return this.request<ApiProject>('/projects', { method: 'POST', body: JSON.stringify(input) }); }
  async createRun(input: Record<string, unknown>): Promise<ApiRun> { return this.request<ApiRun>('/runs', { method: 'POST', body: JSON.stringify(input) }); }
  async getRun(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}`); }
  async approve(runId: string, decision: 'allow' | 'deny' | 'cancel'): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/approval`, { method: 'POST', body: JSON.stringify({ decision }) }); }
  async cancel(runId: string): Promise<Record<string, unknown>> { return this.request(`/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }); }
}

export const backendApi = new BackendApiClient();
export { BackendApiClient };
