/**
 * Session-scoped project/workspace resolver for agent runs.
 *
 * The original store cached the agent project in a module-level object that was
 * never invalidated: after a sign-out and a re-login as a DIFFERENT account the
 * stale project (belonging to the previous tenant) was reused, and a failed
 * creation cached its rejected promise forever, so every later run failed even
 * after the network recovered.
 *
 * This resolver fixes both:
 *   - the cache is keyed by the signed-in identity (tenant + user), so a session
 *     change can never reuse another tenant's project;
 *   - a rejected creation is never cached, so a transient failure is retryable.
 *
 * The client is injected so the logic is unit-testable without react-native.
 */

export interface ProjectClient {
  requireSession(): Promise<{ id: string; tenantId: string }>;
  createProject(input: { name: string }): Promise<{ projectId: string; workspaceId: string }>;
}

export interface ResolvedProject {
  projectId: string;
  workspaceId: string;
}

export class ProjectCache {
  private cache: { key: string; value: ResolvedProject } | null = null;
  private pending: { key: string; promise: Promise<ResolvedProject> } | null = null;

  constructor(
    private readonly client: ProjectClient,
    private readonly name = 'Semo0o Agent Workspace',
  ) {}

  /** Forget any cached/pending project (called on sign-out / session change). */
  reset(): void {
    this.cache = null;
    this.pending = null;
  }

  /** Resolve the agent project for the current session, creating it once. */
  async resolve(): Promise<ResolvedProject> {
    const user = await this.client.requireSession();
    const key = `${user.tenantId}:${user.id}`;
    if (this.cache && this.cache.key === key) return this.cache.value;
    if (this.pending && this.pending.key === key) return this.pending.promise;
    // Different (or no) session: discard anything cached for the old session.
    this.cache = null;
    const promise = this.client
      .createProject({ name: this.name })
      .then((project) => {
        this.cache = { key, value: project };
        if (this.pending && this.pending.key === key) this.pending = null;
        return project;
      })
      .catch((error) => {
        // Never cache a rejected promise: allow a later retry.
        if (this.pending && this.pending.key === key) this.pending = null;
        throw error;
      });
    this.pending = { key, promise };
    return promise;
  }
}
