# Product Acceptance — Ai-Semo0o-Agent

This document records the **acceptance criteria** and the **command-level evidence**
for every feature completed in the current engineering cycle (the missing-feature
completion pass). It is the companion to `PRODUCTION_READINESS.md`: nothing here is
marked `PASS` without a test that was actually executed.

The guiding rule for every item is the project's fail-closed posture:

> A capability that is not configured must be reported as unavailable with its exact
> reason (`TOOL_CONNECTOR_NOT_CONFIGURED:<toolId>`), never faked as a success.

Scope note: **Maestro is an existing integration, not the product name or the goal.**
The product is *Ai-Semo0o-Agent* — a general AI platform for planning, building,
running, testing and shipping large, diverse projects. This cycle only completed the
features that were missing/stubbed; nothing already working was rebuilt.

---

## Baseline (before this cycle)

| Suite | Result |
|-------|--------|
| legacy harness (`tsx test/harness.ts`) | 80/80 |
| execution (`node --test test/*.test.mjs`) | 57/57 |
| phase1 (`tsx --test …`) | 43/43 |
| frontend (`tsx --test …`) | 13/13 |
| phase2 (`node --test …`) | 11/11 |
| backend (`node --experimental-sqlite --test backend/test/*.test.mjs`) | 195/195 |
| **Total** | **399/399 PASS** |

## After this cycle

| Suite | Result |
|-------|--------|
| legacy harness | 80/80 |
| execution | 57/57 |
| phase1 | 43/43 |
| frontend | 13/13 |
| phase2 | 11/11 |
| backend | **212/212** (+17 new integration tests) |
| **Total** | **416/416 PASS** |

Evidence command: `npm test` → `TEST_EXIT=0`.

---

## Feature 1 — Image connector (`image.generate` / `image.analyze`)

**Implementation:** `backend/tools/connectors.mjs` (`createImageProvider`,
`createVisionProvider`), wired in `backend/tools/registry.mjs`.

**Acceptance criteria**
1. `image.generate` calls a real OpenAI-compatible `/images/generations` endpoint when
   `IMAGE_PROVIDER`/`IMAGE_API_KEY` are set, and returns real bytes written under the
   workspace.
2. `image.analyze` calls the configured vision provider (`VISION_PROVIDER`/`VISION_API_KEY`).
3. When nothing is configured, both tools are reported `unwired` with reason
   `image_provider_not_configured` / `vision_provider_not_configured` and the handler
   throws `TOOL_CONNECTOR_NOT_CONFIGURED:<toolId>`.
4. Provider HTTP errors surface as `CONNECTOR_HTTP_<status>` **without leaking the API key**.

**Evidence (backend/test/integrations.test.mjs)**
- `image.generate performs a real OpenAI-compatible call and returns bytes`
- `image.generate surfaces provider HTTP errors without leaking the key`
- `image.analyze uses the configured vision provider`
- `connectors fail closed when nothing is configured`
- `registry reports connector tools live only when a provider is configured`

---

## Feature 2 — Email connector (`email.send`)

**Implementation:** `createEmailSendProvider` in `backend/tools/connectors.mjs`
(Resend / SendGrid / generic webhook), wired in `registry.mjs`.

**Acceptance criteria**
1. `email.send` posts to the configured provider and returns a real message id.
2. Unconfigured → `unwired` with reason `email_provider_not_configured`; handler throws
   `TOOL_CONNECTOR_NOT_CONFIGURED:email.send`.
3. Bounded timeout and bounded response size; errors never leak the credential.

**Evidence**
- `email.send posts to the configured webhook and returns a message id`
- `connectors fail closed when nothing is configured`

---

## Feature 3 — Calendar connector (`calendar.schedule`)

**Implementation:** `createCalendarProvider` in `backend/tools/connectors.mjs`
(Google Calendar / webhook), wired in `registry.mjs`; optional `durationMinutes` and
`description` params added to `backend/agent/catalog.mjs`.

**Acceptance criteria**
1. `calendar.schedule` posts the event to the configured provider and returns the
   provider's event id/link.
2. Unconfigured → `unwired` with reason `calendar_provider_not_configured`; handler
   throws `TOOL_CONNECTOR_NOT_CONFIGURED:calendar.schedule`.

**Evidence**
- `calendar.schedule posts to the configured webhook`

---

## Feature 4 — Managed vector store / embeddings

**Implementation:** `backend/memory/embeddings.mjs` (`localEmbedding`,
`createEmbeddingProvider`, `embeddingStatus`) and the rewritten
`backend/memory/store.mjs` (`MemoryStore` now async, provider-aware, with local
`local-hash-v1` fallback).

**Acceptance criteria**
1. With no managed provider, embeddings use the deterministic local hash embedder and
   `embeddingStatus` reports `{ configured: false, provider: 'local', model: 'local-hash-v1' }`.
2. With `EMBEDDING_PROVIDER`/`EMBEDDING_API_KEY`, `addDocument`/`search`/`reindexProject`
   call the managed OpenAI/Gemini/HTTP endpoint.
3. Tenant isolation is preserved on the async path (cross-tenant search rejects).

**Evidence**
- `embedding provider falls back to local and reports status honestly`
- `managed embedding provider calls the OpenAI-compatible endpoint`
- `backend/test/security-components.test.mjs` (memory isolation, now `await`ed)

---

## Feature 5 — Local Chromium CDP launcher (`browser.run`)

**Implementation:** `backend/browser/launcher.mjs` (`browserBinaryAvailable`,
`launchLocalChromium`, `resolveCdpEndpoint`), wired into `registry.mjs`.

**Acceptance criteria**
1. `resolveCdpEndpoint` prefers `BROWSER_CDP_URL`.
2. Else, when `BROWSER_LAUNCH_LOCAL=true` and a Chromium binary exists, it launches
   Chromium, parses `DevTools listening on ws://…`, and returns the endpoint; the temp
   profile is removed and the process killed on cleanup.
3. When neither is available, it throws `TOOL_CONNECTOR_NOT_CONFIGURED:browser.run`
   and the tool is reported `unwired` (`browser_cdp_not_configured` /
   `browser_binary_not_found`).

**Evidence**
- `browser launcher fails closed without a binary or CDP endpoint`
  (asserts the honest fail-closed behavior in an environment without a local Chromium)

---

## Feature 6 — Stripe billing adapter

**Implementation:** `backend/billing/stripe.mjs` (`createStripeAdapter`,
`billingProviderStatus`), selected by `requireBillingProvider` in
`backend/billing/service.mjs`.

**Acceptance criteria**
1. `billingProviderStatus` returns `configured: true` only when
   `BILLING_PROVIDER=stripe` **and** `BILLING_WEBHOOK_SECRET` **and** `STRIPE_SECRET_KEY`
   are all set; otherwise it returns the exact missing reason.
2. The adapter implements `createCustomer`, `createCheckoutSession`,
   `createPortalSession`, `cancelSubscription` against the real Stripe API
   (`stripe-version: 2024-06-20`, form-encoded, bounded timeout).
3. `requireBillingProvider` throws `BILLING_PROVIDER_NOT_CONFIGURED` when unset and
   `BILLING_PROVIDER_UNSUPPORTED:<provider>` for an unknown provider.

**Evidence**
- `billing provider resolves a real Stripe adapter and reports status`
- `stripe adapter creates customers and checkout sessions`

---

## Feature 7 — GitHub OAuth + repo/issue/PR automation

**Implementation:** `backend/github/service.mjs` (`parseRepoSlug`,
`createGitHubClient`, `buildAuthorizeUrl`, `exchangeCodeForToken`, `getGitHubUser`,
`githubStatus`) and `backend/github/connections.mjs` (encrypted token storage, OAuth
state with 10-minute expiry). Routes added in `backend/server.mjs`:
`GET /github/status`, `POST /github/oauth/start`, `POST /github/oauth/complete`,
`DELETE /github/connection`, `POST /github/repos/:owner/:repo/{info|issues|pulls}`.
Table `github_connections` added to `backend/db/schema.sql`.

**Acceptance criteria**
1. `parseRepoSlug` accepts `owner/repo`, GitHub URLs and rejects invalid slugs.
2. `buildAuthorizeUrl` produces a github.com authorize URL with the given state.
3. `createGitHubClient` creates issues and pull requests via the REST API
   (`2022-11-28`), with hard-coded github.com endpoints (SSRF-safe).
4. OAuth start fails closed with `GITHUB_OAUTH_NOT_CONFIGURED` (HTTP 503) when the
   client id/secret are missing; the state is single-use and expires.
5. The stored token is AES-256-GCM encrypted; `resolveGitHubToken` falls back to
   `GITHUB_TOKEN`/`GH_TOKEN`.

**Evidence**
- `github helpers parse slugs, build authorize urls and validate config`
- `github client creates issues and pull requests over the REST API`
- `integrations status route reports honest connector states` (covers `/github/status`
  and `/github/oauth/start` fail-closed E2E)

---

## Feature 8 — Sentry error tracking

**Implementation:** `backend/observability/error-tracking.mjs`
(`createErrorTracker`, `errorTrackerStatus`), wired into the server error handler so
every HTTP 5xx (except the fail-closed 503s) is captured fire-and-forget.

**Acceptance criteria**
1. A valid `SENTRY_DSN` is parsed into the store URL + `x-sentry-auth` header;
   `errorTrackerStatus` reports `{ configured: true, provider: 'sentry', host }`.
2. An invalid DSN reports `SENTRY_DSN_INVALID` and never throws.
3. `captureException` posts an event and **never throws** on network failure.

**Evidence**
- `error tracking parses a Sentry DSN and stays off when unconfigured`
- `error tracker posts an event and never throws on failure`

---

## Feature 9 — Honest integrations view (`GET /integrations/status`) + frontend

**Implementation (backend):** `backend/server.mjs` route returning
`{ tools, billing, github, embeddings, errorTracking, browser }`, all read from the
real status helpers.

**Implementation (frontend):**
- `src/services/api/client.ts`: `ApiIntegrationsStatus` + `getIntegrationsStatus`,
  `getGitHubStatus`, `startGitHubOAuth`, `completeGitHubOAuth`, `disconnectGitHub`.
- `src/store/useSystemStatusStore.ts`: fetches `/integrations/status` (best-effort).
- `src/components/composite/IntegrationsCard.tsx`: renders honest connector states,
  GitHub connect/disconnect + OAuth completion, and the list of connector-gated tools.
- Wired into `src/screens/Settings.tsx` and `src/screens/Operations.tsx`.

**Acceptance criteria**
1. `/integrations/status` reports each connector's real configured/unwired state.
2. The UI shows `غير مُهيأ` with the exact reason for any unconfigured connector —
   never a fake success.
3. GitHub connect/disconnect actions surface the exact backend error on failure.

**Evidence**
- `integrations status route reports honest connector states`
- `npm run typecheck` → exit 0; `npm run lint` → exit 0 (no warnings)

---

## Cross-cutting acceptance (release gate)

| Check | Command | Result |
|-------|---------|--------|
| Full test suite | `npm test` | 416/416 PASS |
| TypeScript | `npm run typecheck` | PASS (exit 0) |
| Lint | `npm run lint` | PASS (exit 0) |
| Web build | `npm run build` | PASS |
| Security scan | `npm run security:scan` | no findings |
| Backend import verification | `node scripts/verify-imports.mjs backend` | 226/226 resolve (0 broken) |

> Note on the whole-repo import scan: `node scripts/verify-imports.mjs` (no argument)
> still reports the two known **stale root files** (`server.mjs`, `tools/registry.mjs`)
> plus one legacy asset path. These are pre-existing and out of scope for feature
> completion; they are handled (verified then removed) in the bug-fixing phase
> (Phase 5). The backend — the runtime that actually ships — resolves cleanly.

See `PRODUCTION_READINESS.md` for the production infrastructure record and
`FEATURE_FREEZE.md` for the frozen feature manifest.
