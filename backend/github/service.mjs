// GitHub integration: OAuth (authorize + token exchange) and repository
// automation (issues, comments, pull requests) over the fixed GitHub REST API.
// Every network call is bounded and the endpoints are hard-coded to github.com
// so a caller cannot redirect the integration into an SSRF target.

const GITHUB_API = 'https://api.github.com';
const GITHUB_OAUTH_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_OAUTH_TOKEN = 'https://github.com/login/oauth/access_token';

export function parseRepoSlug(slug) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(slug || '').trim());
  if (!match) throw new Error('GITHUB_REPO_INVALID');
  return { owner: match[1], repo: match[2] };
}

// Scrub a configured credential from text that leaves the adapter, so a provider
// (or an intermediary) that echoes the token back can never leak it.
function scrub(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) if (secret && String(secret).length >= 6) out = out.split(String(secret)).join('[REDACTED]');
  return out;
}

async function githubRequest(token, path, { method = 'GET', body, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('GITHUB_API_TIMEOUT')), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(`${GITHUB_API}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'Ai-Semo0o-Agent',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      // Never surface a transport error (it may echo the request URL / headers).
      if (controller.signal.aborted) throw new Error('GITHUB_API_TIMEOUT');
      throw new Error('GITHUB_API_UNREACHABLE');
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = null; }
    if (!response.ok) {
      const code = scrub(data?.message || `HTTP_${response.status}`, [token]);
      throw new Error(`GITHUB_API_ERROR:${response.status}:${code}`);
    }
    return data ?? {};
  } finally {
    clearTimeout(timer);
  }
}

export function createGitHubClient({ token, timeoutMs = 20000 } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN_REQUIRED');
  return {
    async getRepo({ owner, repo }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}`, { timeoutMs });
      return { fullName: data.full_name, defaultBranch: data.default_branch, private: Boolean(data.private), url: data.html_url };
    },
    async listIssues({ owner, repo, state = 'open', limit = 20 }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${Math.min(Math.max(limit, 1), 100)}`, { timeoutMs });
      return data.filter((issue) => !issue.pull_request).map((issue) => ({ number: issue.number, title: issue.title, state: issue.state, url: issue.html_url }));
    },
    async createIssue({ owner, repo, title, body = '', labels = [] }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/issues`, { method: 'POST', body: { title, body, labels }, timeoutMs });
      return { number: data.number, url: data.html_url, title: data.title };
    },
    async commentOnIssue({ owner, repo, issueNumber, body }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/issues/${Number(issueNumber)}/comments`, { method: 'POST', body: { body }, timeoutMs });
      return { id: data.id, url: data.html_url };
    },
    async createPullRequest({ owner, repo, title, head, base, body = '', draft = false }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/pulls`, { method: 'POST', body: { title, head, base, body, draft }, timeoutMs });
      return { number: data.number, url: data.html_url, state: data.state };
    },
    async listPullRequests({ owner, repo, state = 'open', limit = 20 }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=${Math.min(Math.max(limit, 1), 100)}`, { timeoutMs });
      return data.map((pr) => ({ number: pr.number, title: pr.title, state: pr.state, draft: Boolean(pr.draft), head: pr.head?.ref ?? null, base: pr.base?.ref ?? null, url: pr.html_url }));
    },
    async getPullRequest({ owner, repo, number }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/pulls/${Number(number)}`, { timeoutMs });
      return { number: data.number, title: data.title, state: data.state, merged: Boolean(data.merged), mergeable: data.mergeable ?? null, head: data.head?.ref ?? null, base: data.base?.ref ?? null, url: data.html_url, additions: data.additions ?? null, deletions: data.deletions ?? null, changedFiles: data.changed_files ?? null };
    },
    async getIssue({ owner, repo, number }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/issues/${Number(number)}`, { timeoutMs });
      return { number: data.number, title: data.title, state: data.state, body: data.body ?? '', labels: (data.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)), url: data.html_url };
    },
    async listCommits({ owner, repo, ref, limit = 20 }) {
      const query = new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 100)) });
      if (ref) query.set('sha', String(ref));
      const data = await githubRequest(token, `/repos/${owner}/${repo}/commits?${query.toString()}`, { timeoutMs });
      return data.map((commit) => ({ sha: commit.sha, message: commit.commit?.message?.split('\n')[0] ?? '', author: commit.commit?.author?.name ?? null, date: commit.commit?.author?.date ?? null, url: commit.html_url }));
    },
    // CI / commit status: the combined status plus the granular check runs. This
    // is what an autonomous coding loop reads to decide whether the build is
    // green or needs another fix pass.
    async getCombinedStatus({ owner, repo, ref }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status`, { timeoutMs });
      return { state: data.state, totalCount: data.total_count ?? 0, statuses: (data.statuses ?? []).map((status) => ({ context: status.context, state: status.state, description: status.description ?? null, targetUrl: status.target_url ?? null })) };
    },
    async listCheckRuns({ owner, repo, ref }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`, { timeoutMs });
      return { totalCount: data.total_count ?? 0, checkRuns: (data.check_runs ?? []).map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion ?? null, url: run.html_url ?? null, startedAt: run.started_at ?? null, completedAt: run.completed_at ?? null })) };
    },
    async listWorkflowRuns({ owner, repo, branch, limit = 10 }) {
      const query = new URLSearchParams({ per_page: String(Math.min(Math.max(limit, 1), 100)) });
      if (branch) query.set('branch', String(branch));
      const data = await githubRequest(token, `/repos/${owner}/${repo}/actions/runs?${query.toString()}`, { timeoutMs });
      return { totalCount: data.total_count ?? 0, runs: (data.workflow_runs ?? []).map((run) => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion ?? null, headBranch: run.head_branch ?? null, headSha: run.head_sha ?? null, url: run.html_url ?? null, createdAt: run.created_at ?? null })) };
    },
    async getWorkflowRun({ owner, repo, runId }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/actions/runs/${Number(runId)}`, { timeoutMs });
      return { id: data.id, name: data.name, status: data.status, conclusion: data.conclusion ?? null, headBranch: data.head_branch ?? null, headSha: data.head_sha ?? null, url: data.html_url ?? null, createdAt: data.created_at ?? null };
    },
    async listWorkflowRunJobs({ owner, repo, runId }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/actions/runs/${Number(runId)}/jobs`, { timeoutMs });
      return (data.jobs ?? []).map((job) => ({ id: job.id, name: job.name, status: job.status, conclusion: job.conclusion ?? null, steps: (job.steps ?? []).map((step) => ({ name: step.name, status: step.status, conclusion: step.conclusion ?? null })) }));
    },
  };
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, scope = 'repo read:user' }) {
  if (!clientId) throw new Error('GITHUB_OAUTH_CLIENT_ID_REQUIRED');
  if (!redirectUri) throw new Error('GITHUB_OAUTH_REDIRECT_REQUIRED');
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope, state: state || '' });
  return `${GITHUB_OAUTH_AUTHORIZE}?${params.toString()}`;
}

export async function exchangeCodeForToken({ clientId, clientSecret, code, redirectUri, timeoutMs = 20000 }) {
  if (!clientId || !clientSecret) throw new Error('GITHUB_OAUTH_NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('GITHUB_OAUTH_TIMEOUT')), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(GITHUB_OAUTH_TOKEN, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      if (controller.signal.aborted) throw new Error('GITHUB_OAUTH_TIMEOUT');
      throw new Error('GITHUB_OAUTH_UNREACHABLE');
    }
    const data = await response.json();
    if (!response.ok || data.error || !data.access_token) throw new Error(`GITHUB_OAUTH_EXCHANGE_FAILED:${scrub(data.error || response.status, [clientSecret])}`);
    return { token: data.access_token, scope: data.scope ?? null, tokenType: data.token_type ?? 'bearer' };
  } finally {
    clearTimeout(timer);
  }
}

export async function getGitHubUser({ token, timeoutMs = 20000 }) {
  const data = await githubRequest(token, '/user', { timeoutMs });
  return { login: data.login, id: data.id, name: data.name ?? null };
}

export function githubStatus(env = process.env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const oauth = Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET);
  return {
    tokenConfigured: Boolean(token),
    oauthConfigured: oauth,
    configured: Boolean(token) || oauth,
  };
}
