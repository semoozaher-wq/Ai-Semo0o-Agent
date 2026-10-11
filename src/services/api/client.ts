import { resolveBackendUrl } from './backend-url';
import { consumeSse, streamWithReconnect, isAbortError, defaultSleep } from './sse';
import { restoreSessionWith } from './session-restore';
import type { RestoreResult } from './session-restore';
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
export interface ApiAttachment { id: string; name: string; mimeType: string; kind: string; sizeBytes: number; sha256: string; createdAt: string; conversationId?: string | null }
export interface ApiRecoverableConversation { conversationId: string; title: string; interrupted: number }
export interface ApiEvent { type: string; at?: string; stepId?: string; toolId?: string; approvalId?: string; title?: string; reason?: string; final?: string; steps?: number; details?: Record<string, unknown>; [key: string]: unknown }
export interface ApiUsagePoint { date: string; tokens: number; costUsd: number; runs: number; messages: number }
export interface ApiUsageSummary {
  period: string;
  days: number;
  quota: { monthly_tokens: number; monthly_runs: number; monthly_cost_usd: number };
  counter: { tokens: number; runs: number; cost_usd: number };
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
  providers: { image: boolean; vision: boolean; tts: boolean; video: boolean; videoEdit: boolean; music: boolean; mediaAnalysis: boolean };
  // Real generative-video capability. `video` is non-null only when a real
  // video-generation provider is configured; `videoEdit` only when a genuine
  // video-to-video editor is configured. Both are null for the Local Studio.
  video?: ApiCreationVideoCapability | null;
  videoEdit?: ApiCreationVideoEditCapability | null;
  formats: string[];
  resolutions: string[];
}
export interface ApiCreationVideoCapability {
  id: string; model?: string;
  capabilities?: { textToVideo?: boolean; imageToVideo?: boolean; videoExtension?: boolean; videoEditing?: boolean };
  formats?: string[];
}
export interface ApiCreationVideoEditCapability { id: string; model?: string; formats?: string[] }
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
  providers: { image: boolean; vision: boolean; tts: boolean; video: boolean; videoEdit: boolean; music: boolean; mediaAnalysis: boolean };
  // Honest real-video disclosure: `realVideo` is true only when a genuine
  // generative MP4 was produced; `videoError` carries the failure reason when a
  // requested real video could not be generated (never faked).
  realVideo?: boolean;
  videoProvider?: string | null;
  videoModel?: string | null;
  videoError?: string | null;
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
  artifacts: { gif: ApiCreationArtifact | null; avi: ApiCreationArtifact | null; bundle: ApiCreationArtifact | null; mp4: ApiCreationArtifact | null };
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
  // Opt-in REAL generative video: when true (and a real video provider is
  // configured) the job also produces a brand-new MP4 with the video model,
  // exposed as the `mp4` artifact. Off by default so the deterministic Local
  // Studio output is unchanged.
  realVideo?: boolean;
  videoDurationSeconds?: number;
}
// Direct real-video generation (the dedicated /creation/video/generate route).
export interface ApiRealVideoInput {
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  resolution?: string;
  durationSeconds?: number;
  image?: { base64: string; mimeType?: string };
}
export interface ApiRealVideoResult {
  provider: string; model?: string; mimeType: string; bytes: number; base64: string;
}
export interface ApiVideoStatus {
  available: boolean;
  provider: { id: string; model?: string; capabilities?: ApiCreationVideoCapability['capabilities'] } | null;
  editor: { id: string; model?: string } | null;
  capabilities: { textToVideo: boolean; imageToVideo: boolean; videoExtension: boolean; videoEditing: boolean };
  formats: string[];
  reason: string | null;
}

const SESSION_STORAGE_KEY = 'semo0o.backend.session';

/**
 * Session-token persistence seam.
 *
 * The token (never the password) is kept so a returning, already-authorised user
 * stays signed in across reloads. Web uses `localStorage`; native uses the OS
 * keychain via SecureStore. The platform modules are loaded LAZILY (dynamic
 * import) so this module \u2014 the transport + auth logic \u2014 stays importable in a
 * plain Node process (tests, tooling) without pulling in react-native.
 */
export interface TokenStorage {
  read(): Promise<string | null>;
  write(token: string | null): Promise<void>;
}

/**
 * In-memory token storage. Used as the fallback when the platform store is
 * unavailable, and by tests that drive the real client without a device.
 */
export function createMemoryTokenStorage(initial: string | null = null): TokenStorage {
  let value = initial;
  return {
    async read() { return value; },
    async write(token) { value = token; },
  };
}

/** Platform token storage (localStorage on web, SecureStore on native), lazy. */
function createPlatformTokenStorage(): TokenStorage {
  return {
    async read() {
      try {
        const { Platform } = await import('react-native');
        if (Platform.OS === 'web') return globalThis.localStorage?.getItem(SESSION_STORAGE_KEY) ?? null;
        const SecureStore = await import('expo-secure-store');
        return await SecureStore.getItemAsync(SESSION_STORAGE_KEY);
      } catch { return null; }
    },
    async write(token) {
      try {
        const { Platform } = await import('react-native');
        if (Platform.OS === 'web') {
          if (token) globalThis.localStorage?.setItem(SESSION_STORAGE_KEY, token);
          else globalThis.localStorage?.removeItem(SESSION_STORAGE_KEY);
          return;
        }
        const SecureStore = await import('expo-secure-store');
        if (token) await SecureStore.setItemAsync(SESSION_STORAGE_KEY, token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
        else await SecureStore.deleteItemAsync(SESSION_STORAGE_KEY);
      } catch { /* keep the in-memory session if secure persistence is unavailable */ }
    },
  };
}

class BackendApiClient {
  private token: string | null = null;
  private user: ApiUser | null = null;
  private readonly storage: TokenStorage;
  constructor(private readonly baseUrl = resolveBackendUrl(), storage?: TokenStorage) {
    this.storage = storage ?? createPlatformTokenStorage();
  }
  get enabled(): boolean { return Boolean(this.baseUrl); }
  get currentUser(): ApiUser | null { return this.user; }
  get authenticated(): boolean { return Boolean(this.token && this.user); }
  setSession(session: ApiSession | null, user?: ApiUser): void {
    this.token = session?.token ?? null;
    if (user) this.user = user;
    void this.storage.write(this.token);
  }
  clearSession(): void { this.token = null; this.user = null; void this.storage.write(null); }
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
   * session, or null when there is none.
   *
   * IMPORTANT: the token is cleared ONLY when the server definitively rejects it
   * (HTTP 401 / an explicit session-invalid code). A network outage or a server
   * failure (5xx, timeout, CORS) leaves the token intact so the user stays signed
   * in and the session is re-validated once the server recovers — the client must
   * never silently sign a user out on a flaky connection. NEVER creates an
   * account — the previous device auto-registration backdoor is gone.
   */
  async restoreSessionResult(): Promise<RestoreResult<ApiUser>> {
    if (this.token && this.user) return { kind: 'restored', user: this.user };
    return restoreSessionWith<ApiUser>({
      readToken: () => this.storage.read(),
      validate: async (token) => {
        // Present the persisted token for this validation call only; a
        // non-definitive failure keeps it in memory (see `keepSession`).
        this.token = token;
        const { user } = await this.request<{ user: ApiUser }>('/auth/session');
        return user;
      },
      clearSession: () => this.clearSession(),
      keepSession: (token) => { this.token = token; this.user = null; },
    });
  }
  /**
   * Cold-start session restore, collapsed to the resolved user (or null). Callers
   * that must tell an EXPIRED session apart from a transient network/server
   * failure should use `restoreSessionResult()` instead.
   */
  async restoreSession(): Promise<ApiUser | null> {
    const result = await this.restoreSessionResult();
    return result.kind === 'restored' ? result.user : null;
  }
  /**
   * Returns the authenticated user or throws (gate enforcement). A definitive
   * rejection throws `AUTH_REQUIRED`; a transient failure throws
   * `SESSION_UNAVAILABLE` so the caller can retry WITHOUT dropping the session.
   */
  async requireSession(): Promise<ApiUser> {
    if (this.token && this.user) return this.user;
    const result = await this.restoreSessionResult();
    if (result.kind === 'restored') return result.user;
    if (result.kind === 'unavailable') throw new Error('SESSION_UNAVAILABLE');
    throw new Error('AUTH_REQUIRED');
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
  // Upload the real bytes of a device file so the model can receive its actual
  // content (text inlined, images as vision parts). Returns the stored metadata;
  // the `id` is then sent with the chat/run request as an `attachmentIds` entry.
  async uploadAttachment(input: { name: string; mimeType: string; dataBase64: string; conversationId?: string }): Promise<ApiAttachment> { return this.request<ApiAttachment>('/attachments', { method: 'POST', body: JSON.stringify(input) }); }
  /**
   * Fetch a stored attachment's bytes (Bearer-authenticated) and return them as
   * a `data:` URL, so an image attachment can be previewed in the UI. Returns
   * null when the backend is disabled or the fetch fails — the caller falls back
   * to the name/icon pill, never a broken image.
   */
  async fetchAttachmentDataUrl(id: string): Promise<string | null> {
    if (!this.enabled) return null;
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/attachments/${encodeURIComponent(id)}/content`, {
        headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      });
      if (!response.ok) return null;
      const mimeType = response.headers.get('content-type') || 'application/octet-stream';
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
      return `data:${mimeType};base64,${base64}`;
    } catch {
      return null;
    }
  }
  async chat(input: { message: string; model?: string; attachmentIds?: string[] }): Promise<ApiChatResponse> { return this.request<ApiChatResponse>('/chat', { method: 'POST', body: JSON.stringify(input) }); }
  // Streams a chat reply over Server-Sent Events. Each `event:`/`data:` pair is
  // normalised into an `ApiChatStreamFrame` (`start` | `token` | `done` | `error`).
  // The caller accumulates `token` frames; `start` carries the durable
  // conversation/assistant ids so the client can reconcile after a reload.
  //
  // RESILIENCE: if the socket drops mid-answer, the backend keeps generating and
  // persists the FULL reply regardless, so we recover it by fetching the durable
  // assistant message (`recoverChatStream`) rather than re-POSTing — which would
  // start a second turn. The recovered text is delivered as a `resume` frame that
  // REPLACES the caller's buffer, so no fragment is lost or duplicated.
  async chatStream(
    input: { message: string; model?: string; conversationId?: string; attachmentIds?: string[] },
    onFrame: (frame: ApiChatStreamFrame) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.enabled) throw new Error('BACKEND_API_NOT_CONFIGURED');
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/stream`;
    let started: { conversationId?: string; assistantMessageId?: string } = {};
    let terminal = false;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify(input),
        ...(signal === undefined ? {} : { signal }),
      });
      await consumeSse(response, (event) => {
        if (event.event === 'start') started = event.data as { conversationId?: string; assistantMessageId?: string };
        if (event.event === 'done' || event.event === 'error') terminal = true;
        onFrame({ type: event.event, ...(event.data as Record<string, unknown>) } as ApiChatStreamFrame);
      });
    } catch (error) {
      // A client-side abort is intentional (the user pressed stop) -> propagate.
      if (signal?.aborted || isAbortError(error)) throw error;
      // The socket dropped before we knew the durable ids -> nothing to reconcile.
      if (!started.conversationId || !started.assistantMessageId) throw error;
      await this.recoverChatStream(started.conversationId, started.assistantMessageId, onFrame, signal);
      return;
    }
    // The stream ended without a terminal frame (e.g. a proxy closed a 200
    // stream): recover from the durable row so the answer still completes.
    if (!terminal && started.conversationId && started.assistantMessageId) {
      await this.recoverChatStream(started.conversationId, started.assistantMessageId, onFrame, signal);
    }
  }
  /**
   * Resume-by-fetch: poll the durable assistant message until it reaches a
   * terminal status, emitting a `resume` frame with the FULL text each time so
   * the caller's buffer is replaced (never appended). Bounded by `maxAttempts`
   * with exponential backoff; a transient fetch failure just retries.
   */
  private async recoverChatStream(
    conversationId: string,
    assistantMessageId: string,
    onFrame: (frame: ApiChatStreamFrame) => void,
    signal?: AbortSignal,
    { maxAttempts = 12, baseDelayMs = 400, maxDelayMs = 4_000 }: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
  ): Promise<void> {
    let attempt = 0;
    let delay = baseDelayMs;
    for (;;) {
      if (signal?.aborted) return;
      attempt += 1;
      let message: { id: string; content: string; status: string; error?: string | null } | undefined;
      try {
        const conversation = await this.request<{ messages: { id: string; content: string; status: string; error?: string | null }[] }>(`/conversations/${encodeURIComponent(conversationId)}`);
        message = conversation.messages.find((item) => item.id === assistantMessageId);
      } catch {
        if (signal?.aborted || attempt >= maxAttempts) return;
        await defaultSleep(delay, signal);
        delay = Math.min(maxDelayMs, delay * 2);
        continue;
      }
      if (!message) return;
      onFrame({ type: 'resume', conversationId, assistantMessageId, text: message.content, status: message.status, chars: message.content.length } as ApiChatStreamFrame);
      if (message.status === 'complete') { onFrame({ type: 'done', conversationId, assistantMessageId, text: message.content, chars: message.content.length } as ApiChatStreamFrame); return; }
      if (message.status === 'error' || message.status === 'interrupted') { onFrame({ type: 'error', conversationId, assistantMessageId, error: message.error ?? message.status } as ApiChatStreamFrame); return; }
      if (attempt >= maxAttempts) { onFrame({ type: 'done', conversationId, assistantMessageId, text: message.content, chars: message.content.length } as ApiChatStreamFrame); return; }
      await defaultSleep(delay, signal);
      delay = Math.min(maxDelayMs, delay * 2);
    }
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
    const url = `${this.baseUrl.replace(/\/$/, '')}/runs/${encodeURIComponent(runId)}/events`;
    await streamWithReconnect({
      signal,
      // Resume from the last event id after a drop so no timeline event is lost.
      connect: (lastEventId) => fetch(url, {
        headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
        ...(signal === undefined ? {} : { signal }),
      }),
      isTerminal: (event) => event.event === 'close',
      onEvent: (event) => onEvent(event.data as ApiEvent),
    });
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
  /**
   * Absolute URL of a job artefact. NOTE: the artefact route is tenant-scoped
   * and Bearer-authenticated, so this URL is NOT directly openable — a bare
   * `Linking.openURL` on it 401s. Use `fetchCreationArtifact` to download the
   * bytes with the session token.
   */
  creationArtifactUrl(id: string, name: 'gif' | 'avi' | 'bundle' | 'mp4'): string {
    return `${this.baseUrl.replace(/\/$/, '')}/creation/jobs/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`;
  }
  /**
   * Download a job artefact's bytes WITH the session token. The route requires
   * auth (Bearer, no cookies), so the UI must fetch it here rather than hand the
   * bare URL to the OS/browser. Returns the raw bytes plus the server-declared
   * MIME type and download filename.
   */
  async fetchCreationArtifact(id: string, name: 'gif' | 'avi' | 'bundle' | 'mp4'): Promise<{ bytes: Uint8Array; mimeType: string; filename: string }> {
    if (!this.enabled) throw new Error('BACKEND_API_NOT_CONFIGURED');
    const response = await fetch(this.creationArtifactUrl(id, name), {
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(String(payload.error ?? `BACKEND_${response.status}`));
    }
    const buffer = await response.arrayBuffer();
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    const disposition = response.headers.get('content-disposition') || '';
    const match = /filename="?([^";]+)"?/.exec(disposition);
    return { bytes: new Uint8Array(buffer), mimeType, filename: match?.[1] ?? name };
  }
  // Dedicated real-video surface: status disclosure + direct generation.
  async getVideoStatus(): Promise<ApiVideoStatus> { return this.request<ApiVideoStatus>('/creation/video'); }
  async generateRealVideo(input: ApiRealVideoInput): Promise<ApiRealVideoResult> {
    return this.request<ApiRealVideoResult>('/creation/video/generate', { method: 'POST', body: JSON.stringify(input) });
  }
  async streamCreationEvents(id: string, onEvent: (event: ApiCreationEvent) => void, signal?: AbortSignal): Promise<void> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/creation/jobs/${encodeURIComponent(id)}/events`;
    await streamWithReconnect({
      signal,
      connect: (lastEventId) => fetch(url, {
        headers: { accept: 'text/event-stream', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
        ...(signal === undefined ? {} : { signal }),
      }),
      isTerminal: (event) => event.event === 'close',
      onEvent: (event) => onEvent(event.data as ApiCreationEvent),
    });
  }
}

export const backendApi = new BackendApiClient();
export { BackendApiClient };
export type { ApiAccount, ApiAccountDeletion, ApiAccountExport, ApiMfaSetup, DeleteAccountInput } from '../account/api';
