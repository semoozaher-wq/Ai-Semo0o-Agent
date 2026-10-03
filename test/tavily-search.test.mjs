import assert from 'node:assert/strict';
import test from 'node:test';
import { TavilySearchClient, TavilySearchError, createTavilySearchTool } from '../execution-core/tavily-search.mjs';

function response({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('Tavily client sends server-side bearer auth and normalizes live results', async () => {
  const requests = [];
  const client = new TavilySearchClient({
    apiKey: 'tvly-secret',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response({ body: { answer: 'summary', results: [{ title: 'A', url: 'https://a.test', content: 'snippet', score: 0.9, published_date: '2026-01-01' }] } });
    },
  });
  const result = await client.search({ query: 'agent runtime', limit: 5 });
  assert.equal(result.provider, 'tavily');
  assert.equal(result.results[0].snippet, 'snippet');
  assert.equal(requests[0].options.headers.authorization, 'Bearer tvly-secret');
  assert.deepEqual(JSON.parse(requests[0].options.body), { query: 'agent runtime', max_results: 5, topic: 'general', search_depth: 'basic' });
});

test('Tavily client retries transient rate limits and stops after bounded attempts', async () => {
  let calls = 0;
  const sleeps = [];
  const client = new TavilySearchClient({
    apiKey: 'tvly-secret',
    sleep: async (ms) => sleeps.push(ms),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? response({ status: 429, headers: { 'retry-after': '0' } }) : response({ body: { results: [] } });
    },
  });
  const result = await client.search({ query: 'retry me' });
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [0]);
});

test('Tavily client fails closed for missing keys and invalid arguments', async () => {
  assert.throws(() => new TavilySearchClient({ apiKey: '' }), (error) => error instanceof TavilySearchError && error.code === 'TAVILY_API_KEY_MISSING');
  await assert.rejects(() => new TavilySearchClient({ apiKey: 'tvly-secret' }).search({ query: '' }), /query is required/);
});

test('tool adapter returns provider evidence and does not log the API key', async () => {
  const tool = createTavilySearchTool({
    apiKey: 'tvly-secret',
    fetchImpl: async () => response({ body: { results: [{ title: 'A', url: 'https://a.test', content: 'x' }] } }),
  });
  const result = await tool({ query: 'safe query', limit: 1 });
  assert.equal(result.output.provider, 'tavily');
  assert.equal(result.output.sourceCount, 1);
  assert.equal(result.logs.some((log) => log.includes('tvly-secret')), false);
});
