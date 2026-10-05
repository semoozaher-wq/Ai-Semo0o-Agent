import { randomUUID } from 'node:crypto';

export const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

export class TavilySearchError extends Error {
  constructor(message, code = 'TAVILY_SEARCH_FAILED', details = undefined) {
    super(message);
    this.name = 'TavilySearchError';
    this.code = code;
    this.details = details;
  }
}

function positiveInteger(value, fallback, name, maximum) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TavilySearchError(`${name} must be an integer between 1 and ${maximum}.`, 'INVALID_SEARCH_ARGUMENT');
  }
  return resolved;
}

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get?.('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1_000, 5_000);
  return Math.min(250 * (2 ** attempt), 2_000);
}

function normalizeResults(payload) {
  const raw = Array.isArray(payload?.results) ? payload.results : [];
  return raw.map((item) => ({
    title: typeof item.title === 'string' ? item.title : '',
    url: typeof item.url === 'string' ? item.url : '',
    snippet: typeof item.content === 'string' ? item.content : '',
    score: typeof item.score === 'number' ? item.score : undefined,
    publishedAt: typeof item.published_date === 'string' ? item.published_date : undefined,
  })).filter((item) => item.url && item.title);
}

export class TavilySearchClient {
  constructor({
    apiKey = process.env.TAVILY_API_KEY,
    endpoint = TAVILY_ENDPOINT,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxRetries = 2,
    timeoutMs = 15_000,
  } = {}) {
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new TavilySearchError('TAVILY_API_KEY is required on the server.', 'TAVILY_API_KEY_MISSING');
    }
    if (typeof fetchImpl !== 'function') {
      throw new TavilySearchError('A server-side fetch implementation is required.', 'FETCH_UNAVAILABLE');
    }
    this.apiKey = apiKey.trim();
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.maxRetries = Math.max(0, Math.min(maxRetries, 3));
    this.timeoutMs = positiveInteger(timeoutMs, 15_000, 'timeoutMs', 120_000);
  }

  async search({
    query,
    limit = 5,
    topic = 'general',
    searchDepth = 'basic',
    timeRange,
    includeDomains,
    excludeDomains,
  } = {}) {
    if (typeof query !== 'string' || query.trim() === '') {
      throw new TavilySearchError('query is required.', 'INVALID_SEARCH_ARGUMENT');
    }
    const maxResults = positiveInteger(limit, 5, 'limit', 20);
    if (!['general', 'news', 'finance'].includes(topic)) {
      throw new TavilySearchError('topic must be general, news, or finance.', 'INVALID_SEARCH_ARGUMENT');
    }
    if (!['advanced', 'basic', 'fast', 'ultra-fast'].includes(searchDepth)) {
      throw new TavilySearchError('searchDepth is invalid.', 'INVALID_SEARCH_ARGUMENT');
    }
    const body = {
      query: query.trim(),
      max_results: maxResults,
      topic,
      search_depth: searchDepth,
      ...(timeRange ? { time_range: timeRange } : {}),
      ...(Array.isArray(includeDomains) && includeDomains.length ? { include_domains: includeDomains.slice(0, 20) } : {}),
      ...(Array.isArray(excludeDomains) && excludeDomains.length ? { exclude_domains: excludeDomains.slice(0, 20) } : {}),
    };
    const runId = randomUUID();
    const started = Date.now();
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.ok) {
          const payload = await response.json();
          const results = normalizeResults(payload);
          return {
            runId,
            provider: 'tavily',
            query: body.query,
            results,
            answer: typeof payload.answer === 'string' ? payload.answer : undefined,
            sourceCount: results.length,
            searchedAt: new Date().toISOString(),
            durationMs: Date.now() - started,
            attempts: attempt + 1,
          };
        }
        const bodyText = await response.text().catch(() => '');
        lastError = new TavilySearchError(
          `Tavily returned HTTP ${response.status}.`,
          response.status === 401 || response.status === 403 ? 'TAVILY_AUTH_FAILED' : response.status === 429 ? 'TAVILY_RATE_LIMITED' : 'TAVILY_HTTP_ERROR',
          { status: response.status, body: bodyText.slice(0, 500) },
        );
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= this.maxRetries) throw lastError;
        await this.sleep(retryDelay(response, attempt));
      } catch (error) {
        lastError = error instanceof TavilySearchError
          ? error
          : new TavilySearchError(error?.name === 'AbortError' ? 'Tavily request timed out.' : String(error), error?.name === 'AbortError' ? 'TAVILY_TIMEOUT' : 'TAVILY_NETWORK_ERROR');
        if (attempt >= this.maxRetries) throw lastError;
        await this.sleep(Math.min(250 * (2 ** attempt), 2_000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new TavilySearchError('Tavily search failed.');
  }
}

/** Adapter shape for a server-side tool registry. Never import this into Expo. */
export function createTavilySearchTool(options = {}) {
  const client = new TavilySearchClient(options);
  return async (args) => ({
    output: await client.search({
      query: args.query,
      limit: args.limit,
      topic: args.topic,
      searchDepth: args.searchDepth,
      timeRange: args.timeRange,
      includeDomains: args.includeDomains,
      excludeDomains: args.excludeDomains,
    }),
    logs: [`Tavily returned live web evidence for: ${String(args.query).slice(0, 120)}`],
  });
}
