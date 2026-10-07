# Feature Freeze — Ai-Semo0o-Agent

**Status:** FROZEN
**Scope:** The feature set below is frozen for the production-hardening cycle.
No new features will be added until every phase (bug-fixing → security →
performance → infra → QA → audit → readiness) is complete. Only fixes,
hardening and documentation are permitted from this point.

**Product definition (authoritative):** Ai-Semo0o-Agent is a *general* AI agent
platform for planning, building, running, testing and shipping large and diverse
projects (apps, websites, SaaS, agents, systems). It is **not** a single-purpose
chatbot and **not** a rebrand of any existing product. *Maestro* is one existing
integration inside the platform, not the product name or the goal.

---

## 1. Frozen capabilities

### 1.1 Agent runtime & orchestration
- Agent runtime (`backend/agent/runtime.mjs`), task routing, planning, execution,
  recovery and verification with evidence.
- Tool catalog + live registry (`backend/agent/catalog.mjs`,
  `backend/tools/registry.mjs`) with `TOOL_CATALOG`, `TOOL_BY_ID`, `DANGEROUS_TOOLS`.
- Queue + worker (`backend/queue/queue.mjs`, `backend/worker.mjs`).
- Durable runs with SSE run-event streaming.

### 1.2 Identity, tenancy & org
- Auth: register / login / logout, email verification, password reset, MFA
  (`backend/auth/*`).
- Sessions, multi-tenancy, organizations, members, invitations
  (`backend/org/*`).
- Account & data deletion + export (`backend/account/deletion.mjs`, `DELETE /me`,
  `GET /me/export`).

### 1.3 Persistence & data
- SQLite via `node --experimental-sqlite` with a custom `Database` wrapper
  (`backend/db/client.mjs`), idempotent schema (`backend/db/schema.sql`),
  ALTER-based migrations, indexes, WAL, idempotency.
- Chat persistence + recovery (`backend/chat/store.mjs`).

### 1.4 Memory / RAG / vector
- Memory store + context (`backend/memory/store.mjs`).
- Embedding provider with local fallback (`backend/memory/embeddings.mjs`).
- RAG / vector search foundation.

### 1.5 Tools & connectors
- Code execution (`backend/runners/code-runner.mjs`).
- Browser over CDP (`backend/browser/pool.mjs`, `backend/browser/launcher.mjs`,
  `phase2-core/browser-agent.mjs`).
- Image generate/analyze, email send, calendar schedule
  (`backend/tools/connectors.mjs`) — all fail-closed.
- GitHub OAuth + repo/issue/PR automation (`backend/github/*`).

### 1.6 Billing
- Plans (free/pro/team), Stripe-style webhook HMAC verification, idempotent
  events (`backend/billing/*`).

### 1.7 Observability & ops
- Metrics, telemetry, monitoring & alerting (`backend/observability/*`).
- Sentry error tracking (`backend/observability/error-tracking.mjs`).
- Notifications outbox (`backend/notifications/outbox.mjs`).
- Retention (`backend/ops/retention.mjs`), backup/restore drill
  (`backend/ops/backup.mjs`).
- Self-improve / self-healing engine (`backend/self-improve/*`).

### 1.8 Security
- SSRF guards (`assertSafeUrlResolved`, `assertWorkspacePath`), secret redaction
  (`redactDeep`, `collectKnownSecrets`, `redactSecrets`), security headers,
  secrets vault AES-256-GCM (`backend/secrets/vault.mjs`).

### 1.9 Frontend (Expo / React Native)
- Chat, Agents, Files, Store, Workspace, Analytics, Anatomy, Settings, Operations.
- API client + SSE, chat streaming + recovery, system status panel, and the new
  **Integrations / connectors** panel (`IntegrationsCard`).

### 1.10 CI/CD & deployment
- GitHub Actions, Dockerfile, render.yaml, boot smoke, release gate.

---

## 2. Frozen HTTP surface

`/health`, `/ready`, `/metrics`, `/auth/*`, `/me`, `/me/export`, `/org/*`,
`/projects`, `/tasks`, `/runs/*` (+ events, approval, cancel, retry, pause,
resume), `/chat`, `/chat/stream`, `/chat/recoverable`, `/conversations/*`,
`/usage`, `/tools/status`, `/models/status`, `/billing/status`,
`/billing/checkout`, `/billing/portal`, `/billing/subscription/cancel`,
`/billing/webhook`, `/notifications/outbox`, `/notifications/outbox/process`,
`/ops/alerts`, `/ops/retention/run`, `/self-improve/*`, `/integrations/status`,
`/github/status`, `/github/oauth/start`, `/github/oauth/complete`,
`/github/connection`, `/github/repos/:owner/:repo/{info|issues|pulls}`.

---

## 3. Change control during freeze

| Change type | Allowed? |
|-------------|----------|
| Bug fix (with a regression test) | Yes |
| Security hardening | Yes |
| Performance / concurrency fix | Yes |
| Documentation / infra config | Yes |
| New feature / new endpoint | **No** |
| Behaviour change to a frozen endpoint | Only if it fixes a defect |

---

## 4. Frozen baseline evidence

- Tests: **416/416 PASS** (`npm test`, `TEST_EXIT=0`).
- TypeScript: `npm run typecheck` → exit 0.
- Lint: `npm run lint` → exit 0.
- Web build: `npm run build` → 20 routes, exit 0.
- Security scan: `npm run security:scan` → no findings.
- Backend imports: `node scripts/verify-imports.mjs backend` → 226/226 resolve.

This manifest is the reference for the remaining phases; any deviation must be
recorded here with a justification.
