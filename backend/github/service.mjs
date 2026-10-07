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
