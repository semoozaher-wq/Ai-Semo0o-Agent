// GitHub integration: OAuth (authorize + token exchange) and repository
// automation (issues, comments, pull requests) over the fixed GitHub REST API.
// Every network call is bounded and the endpoints are hard-coded to github.com
// so a caller cannot redirect the integration into an SSRF target.

import JSZip from 'jszip';

const GITHUB_API = 'https://api.github.com';
const GITHUB_OAUTH_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_OAUTH_TOKEN = 'https://github.com/login/oauth/access_token';

// Hosts GitHub is allowed to redirect a log download to. The initial request is
// always pinned to api.github.com; this guard stops a spoofed Location header
// from turning the download into an SSRF/exfil vector.
const ALLOWED_LOG_HOSTS = /(^|\.)(github\.com|githubusercontent\.com|githubassets\.com)$/i;

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

// Download a GitHub-hosted archive (currently only the Actions log bundle, which
// the API serves as a 302 to a short-lived signed URL). The redirect target is
// validated against the GitHub host allow-list before it is followed.
async function githubDownload(token, path, { timeoutMs: ms = 45000, maxBytes = 16 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('GITHUB_API_TIMEOUT')), ms);
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Ai-Semo0o-Agent', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  try {
    let response;
    try {
      response = await fetch(`${GITHUB_API}${path}`, { headers, redirect: 'manual', signal: controller.signal });
    } catch {
      if (controller.signal.aborted) throw new Error('GITHUB_API_TIMEOUT');
      throw new Error('GITHUB_API_UNREACHABLE');
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location') || '';
      let parsed;
      try { parsed = new URL(location); } catch { throw new Error('GITHUB_LOG_REDIRECT_INVALID'); }
      if (parsed.protocol !== 'https:' || !ALLOWED_LOG_HOSTS.test(parsed.hostname)) throw new Error('GITHUB_LOG_REDIRECT_BLOCKED');
      let asset;
      try {
        asset = await fetch(parsed.toString(), { redirect: 'follow', signal: controller.signal });
      } catch {
        if (controller.signal.aborted) throw new Error('GITHUB_API_TIMEOUT');
        throw new Error('GITHUB_API_UNREACHABLE');
      }
      if (!asset.ok) throw new Error(`GITHUB_LOG_HTTP_${asset.status}`);
      const arrayBuffer = await asset.arrayBuffer();
      if (arrayBuffer.byteLength > maxBytes) throw new Error('GITHUB_LOG_TOO_LARGE');
      return { response: asset, buffer: Buffer.from(arrayBuffer) };
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`GITHUB_API_ERROR:${response.status}:${scrub(text.slice(0, 200), [token])}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) throw new Error('GITHUB_LOG_TOO_LARGE');
    return { response, buffer: Buffer.from(arrayBuffer) };
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
    // Download and unzip the Actions run log bundle into per-file text. This is
    // the raw evidence an autonomous fix loop reads to understand *why* CI failed
    // (the step-level conclusion alone is not enough to plan a fix).
    async downloadWorkflowRunLogs({ owner, repo, runId, maxBytes = 4 * 1024 * 1024 }) {
      const { buffer } = await githubDownload(token, `/repos/${owner}/${repo}/actions/runs/${Number(runId)}/logs`, { timeoutMs: timeoutMs + 25000 });
      let zip;
      try { zip = await JSZip.loadAsync(buffer); } catch { throw new Error('GITHUB_LOG_ARCHIVE_INVALID'); }
      const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
      const files = [];
      let total = 0;
      for (const name of names) {
        if (total >= maxBytes) break;
        let content = '';
        try { content = await zip.files[name].async('string'); } catch { continue; }
        const clipped = content.slice(0, Math.max(0, maxBytes - total));
        total += clipped.length;
        files.push({ name, bytes: Buffer.byteLength(content), text: clipped });
      }
      return { runId: Number(runId), files, truncated: total >= maxBytes, totalBytes: total };
    },
    async rerunWorkflowRun({ owner, repo, runId }) {
      await githubRequest(token, `/repos/${owner}/${repo}/actions/runs/${Number(runId)}/rerun`, { method: 'POST', timeoutMs });
      return { runId: Number(runId), rerun: true };
    },
    async rerunFailedJobs({ owner, repo, runId }) {
      await githubRequest(token, `/repos/${owner}/${repo}/actions/runs/${Number(runId)}/rerun-failed-jobs`, { method: 'POST', timeoutMs });
      return { runId: Number(runId), rerunFailedJobs: true };
    },
    async listPullRequestReviews({ owner, repo, number }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/pulls/${Number(number)}/reviews`, { timeoutMs });
      return data.map((review) => ({ id: review.id, user: review.user?.login ?? null, state: review.state, body: String(review.body ?? '').slice(0, 2000), submittedAt: review.submitted_at ?? null }));
    },
    async getPullRequestFiles({ owner, repo, number, limit = 100 }) {
      const data = await githubRequest(token, `/repos/${owner}/${repo}/pulls/${Number(number)}/files?per_page=${Math.min(Math.max(limit, 1), 100)}`, { timeoutMs });
      return data.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions ?? 0, deletions: file.deletions ?? 0, changes: file.changes ?? 0 }));
    },
    async mergePullRequest({ owner, repo, number, method = 'squash', commitTitle }) {
      const mergeMethod = ['merge', 'squash', 'rebase'].includes(method) ? method : 'squash';
      const body = { merge_method: mergeMethod };
      if (commitTitle) body.commit_title = String(commitTitle).slice(0, 256);
      const data = await githubRequest(token, `/repos/${owner}/${repo}/pulls/${Number(number)}/merge`, { method: 'PUT', body, timeoutMs });
      return { merged: Boolean(data.merged), sha: data.sha ?? null, message: data.message ?? null };
    },
    // Composite verification: PR state + reviews + checks + changed files. The
    // autonomous loop calls this to decide whether a PR is truly ready to merge.
    async verifyPullRequest({ owner, repo, number }) {
      const pr = await this.getPullRequest({ owner, repo, number });
      const ref = pr.head ?? 'HEAD';
      const [reviews, files, combined, checks] = await Promise.all([
        this.listPullRequestReviews({ owner, repo, number }).catch(() => []),
        this.getPullRequestFiles({ owner, repo, number }).catch(() => []),
        this.getCombinedStatus({ owner, repo, ref }).catch(() => null),
        this.listCheckRuns({ owner, repo, ref }).catch(() => null),
      ]);
      const approvals = reviews.filter((review) => review.state === 'APPROVED').length;
      const changesRequested = reviews.filter((review) => review.state === 'CHANGES_REQUESTED').map((review) => review.user);
      const checkRuns = checks?.checkRuns ?? [];
      const failing = checkRuns.filter((run) => run.conclusion && !['success', 'neutral', 'skipped'].includes(run.conclusion)).map((run) => run.name);
      const pending = checkRuns.filter((run) => run.status && run.status !== 'completed').map((run) => run.name);
      const green = combined?.state === 'success' && failing.length === 0 && pending.length === 0;
      const mergeable = pr.mergeable !== false && pr.state === 'open';
      let verdict = 'ready';
      if (pr.merged) verdict = 'merged';
      else if (pr.state !== 'open') verdict = 'closed';
      else if (changesRequested.length > 0) verdict = 'changes_requested';
      else if (!mergeable) verdict = 'conflicts';
      else if (failing.length > 0) verdict = 'failing';
      else if (pending.length > 0 || (combined && combined.state === 'pending')) verdict = 'pending';
      else if (!green) verdict = 'unknown';
      return { number: pr.number, state: pr.state, merged: pr.merged, mergeable, head: pr.head, base: pr.base, approvals, changesRequested, reviews, files, combinedState: combined?.state ?? 'unknown', checkRuns, failing, pending, green, verdict, url: pr.url };
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
