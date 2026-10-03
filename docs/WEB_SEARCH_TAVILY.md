# `web.search` — Tavily Server Adapter

## Status

`execution-core/tavily-search.mjs` provides a real Tavily Search adapter for a
Node.js backend. It is deliberately not imported into the Expo bundle.

## Security contract

- Set `TAVILY_API_KEY` only on the server or pass it to the server adapter.
- Never store the key in AsyncStorage, localStorage, Expo settings, or client code.
- Never include the key in logs, evidence, errors, or tool output.
- Apply authentication, tenant authorization, rate limits and usage quotas at the API boundary.

## Usage

```js
import { createTavilySearchTool } from './execution-core/tavily-search.mjs';

const webSearch = createTavilySearchTool({
  apiKey: process.env.TAVILY_API_KEY,
});

const result = await webSearch({
  query: 'latest autonomous agent runtime patterns',
  limit: 5,
  searchDepth: 'basic',
});
```

The adapter calls `POST https://api.tavily.com/search` with Bearer authentication
and returns normalized evidence:

- provider
- runId
- query
- result title/url/snippet/score/date
- optional answer
- sourceCount
- duration
- attempts

Transient HTTP failures (`429`, `500`, `502`, `503`, `504`) receive bounded
retries with `Retry-After` support. Authentication failures and invalid input
fail immediately. Requests have an AbortController timeout.

## Integration boundary

The current Expo tool registry is client-side. Do not register this adapter in
the Expo bundle. The production wiring should be:

```text
Expo Client
  → authenticated backend tool endpoint
  → TavilySearchClient
  → Tavily API
  → normalized evidence
  → orchestrator verification/citation step
```

Tavily results are **retrieval evidence**, not proof that a task is correct.
Research tasks should deduplicate URLs, optionally extract source pages, compare
claims across sources, and store citations before allowing a verified result.
