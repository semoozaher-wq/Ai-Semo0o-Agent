# Deployment Guide — Ai-Semo0o-Agent

This guide covers how to run the backend (API + worker) and the Expo client in development,
staging, and production, plus the operational topology and quality gates.

> Companion docs: [`PRODUCTION.md`](PRODUCTION.md) (config + readiness matrix),
> [`INCIDENT_RUNBOOK.md`](INCIDENT_RUNBOOK.md), [`SLO_AND_RESTORE_DRILL.md`](SLO_AND_RESTORE_DRILL.md).

---

## 1. Runtime requirements

| Component | Requirement | Notes |
|-----------|-------------|-------|
| Node.js | **≥ 22.5.0** | required for built-in `node:sqlite` (`DatabaseSync`) |
| npm | ≥ 10.9.0 | |
| Backend deps | **none** | pure `node:` builtins + relative imports |
| Chromium | optional | only needed for `browser.run` / `browser.extract` |
| git | ≥ 2.39 | only needed for `github.*` clone/commit/push |
| poppler (`pdftotext`) | optional | fallback PDF text extraction |

The backend is intentionally dependency-free so it can run on a minimal Node image. The Expo client
and the tooling (typecheck/lint/tests) use the dev dependencies in `package.json`.

---

## 2. Processes / topology

The backend is a single Node process that can run in three shapes:

1. **All-in-one (default, small deployments)** — `npm run start:backend`.
   Serves HTTP and runs the agent-run worker in-process.
2. **Split (recommended for production)** — run the API with `DISABLE_WORKER=true` and one or more
   workers via `npm run start:worker`. Scale workers horizontally; they share the SQLite database
   with lease-based claiming (`WORKER_LEASE_MS`, `WORKER_MAX_ATTEMPTS`, `WORKER_CONCURRENCY`).
3. **API-only** — `DISABLE_WORKER=true` with no workers (queue accumulates; useful for maintenance).

```
        ┌────────────┐        ┌────────────┐
client ─►│  API node  │───────►│  SQLite DB │◄───────┐
        │ (no worker)│        └────────────┘        │
        └────────────┘              ▲                │
                                    │ lease/claim    │
                            ┌───────┴───────┐  ┌─────┴─────────┐
                            │  worker #1    │  │  worker #N    │
                            └───────────────┘  └───────────────┘
```

> **Note on SQLite concurrency:** `node:sqlite` is a single-file embedded database. For a
> multi-worker topology keep the DB on a local high-performance volume (not a network filesystem)
> and rely on the lease mechanism for coordination. For very high write concurrency, plan a
> migration to a client/server database — the DB access is isolated in `backend/db/client.mjs`.

---

## 3. Configuration

Copy the template and fill it in:

```bash
cp .env.example .env
```

### 3.1 Production-required (enforced by `assertEnv`)

When `NODE_ENV=production`, the process refuses to start unless:

- `SECRETS_MASTER_KEY` is set and **≥ 32 bytes** (base64 or hex). Generate with `openssl rand -base64 48`.
- `DATABASE_FILE` is set and **absolute**.
- `WORKSPACE_ROOT` is set and **absolute**.
- `ALLOWED_ORIGIN` is set and **not** `*`.
- If `BILLING_PROVIDER` is set, `BILLING_WEBHOOK_SECRET` must be set and **≥ 16 bytes**.
- If `BROWSER_CDP_URL` is set, it must be a `ws://` or `wss://` URL.

A missing LLM key is a **warning** (`NO_LLM_PROVIDER_CONFIGURED`), not a hard failure — the server
starts but agent chat/planning will fail-closed until a provider is configured.

### 3.2 Minimal production `.env`

```env
NODE_ENV=production
PORT=8787
BIND_HOST=0.0.0.0
ALLOWED_ORIGIN=https://app.example.com
PUBLIC_APP_URL=https://app.example.com

DATABASE_FILE=/var/lib/semo0o/app.db
WORKSPACE_ROOT=/var/lib/semo0o/workspace
SECRETS_MASTER_KEY=<openssl rand -base64 48>

DISABLE_WORKER=true                 # API node; run workers separately
WORKER_CONCURRENCY=4

OPENAI_API_KEY=<...>                # at least one LLM provider
```

---

## 4. Build & run

### Backend

```bash
npm ci                              # install (backend itself needs no deps)
npm run start:backend               # API (+ worker unless DISABLE_WORKER=true)
npm run start:worker                # worker (when DISABLE_WORKER=true on the API)
```

### Client (Expo)

```bash
npm run web                         # dev web
npm run build                       # expo export --platform web -> dist/
```

Serve `dist/` as a static site (any CDN/static host). The client talks to the backend via
`PUBLIC_APP_URL`/`ALLOWED_ORIGIN`.

### Container sketch (Dockerfile)

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci --omit=dev
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=8787
VOLUME ["/var/lib/semo0o"]
CMD ["node", "backend/server.mjs"]
```

Mount a persistent volume for `DATABASE_FILE` and `WORKSPACE_ROOT`. If you need the browser tools,
install Chromium in the image and set `CHROMIUM_BIN` (or run a sidecar Chrome and set `BROWSER_CDP_URL`).

---

## 5. Data & persistence

- **Database:** `DATABASE_FILE` (SQLite). Back it up with the SQLite online backup API or a
  filesystem snapshot while the process is quiesced. See `backend/ops/sqlite-archive.mjs`.
- **Workspace:** `WORKSPACE_ROOT` holds cloned repos and generated files. It is sandboxed; all paths
  are resolved with symlink-escape prevention. Back it up or treat it as ephemeral per policy.
- **Secrets:** tenant secrets are encrypted at rest with AES-256-GCM using `SECRETS_MASTER_KEY`.
  **Losing the master key means losing the ability to decrypt stored secrets.** Store it in a
  secrets manager, never in the image or repo.

---

## 6. Health, readiness, observability

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | liveness — process is up. Returns `{ ok, service, version, uptimeSeconds, time }`. |
| `GET /ready`  | readiness — returns `200` only when **all** checks pass, else `503` with a structured `checks` object: `database` (DB reachable), `workspace` (writable when `WORKSPACE_ROOT` is set), `providers` (≥1 configured and healthy LLM provider). Fails **closed**. |
| `GET /tools/status` | which tools are `live` vs `unwired` vs `catalogOnly` vs `simulated` vs `dangerous`, plus an additive `summary` with the counts. |
| `GET /models/status` | LLM provider health (configured / healthy). |
| `GET /billing/status` | billing provider + subscription state. |
| `GET /usage` | token/cost accounting and quota. |

Use `/health` for the liveness probe and `/ready` for the readiness probe. Point your load balancer
at `/ready` so a node with an unreachable DB or no healthy LLM provider is taken out of rotation.

### 6.1 Structured logging

Request logging is **env-gated** and routed through `backend/observability/telemetry.mjs`:

```env
LOG_FORMAT=json      # or "pretty"; enables structured request logging
LOG_LEVEL=info       # alternatively, set a level to enable logging
```

When neither `LOG_FORMAT` nor `LOG_LEVEL` is set, logging is disabled (a no-op sink, zero overhead)
and production emits the warning `LOG_FORMAT_NOT_SET`. Each request emits one `http.request` event
with `requestId`, `method`, `path`, `status`, and `durationMs`. The codebase surfaces environment
variable **names**, never values — keep it that way in your collector.

### 6.2 Backup & restore

`DATABASE_FILE` is SQLite. Use the built-in archive CLI (it runs `PRAGMA integrity_check`,
`foreign_key_check`, and a schema-recognition check; destinations must **not** already exist):

```bash
# backup <source-db> <new-backup-file>
node backend/ops/sqlite-archive.mjs backup "$DATABASE_FILE" /backups/app-$(date +%F).db

# verify <database-file>
node backend/ops/sqlite-archive.mjs verify /backups/app-$(date +%F).db

# restore <backup-file> <new-database-file>
node backend/ops/sqlite-archive.mjs restore /backups/app-$(date +%F).db /var/lib/semo0o/app-restored.db
```

Run `verify` after every `backup`, and rehearse `restore` on a scratch copy — see
`docs/SLO_AND_RESTORE_DRILL.md`. (Covered by `backend/test/database-archive.test.mjs`.)

---

## 7. Quality gates (run in CI before deploy)

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # expo lint
npm run security:scan   # scripts/security-scan.mjs
npm run test:backend    # 108 node:test cases (capability + contract + E2E + readiness)
npm test                # full suite
npm run build           # expo export --platform web
```

A release is deployable only when all gates are green. See the P5 report for the latest evidence.

---

## 8. Scaling notes

- **API** scales horizontally behind a load balancer; sessions are DB-backed, so any node can serve
  any request. Set `ALLOWED_ORIGIN` to your exact client origin.
- **Workers** scale horizontally; increase `WORKER_CONCURRENCY` and add processes. Watch lease
  duration vs. longest agent run (`AGENT_TIMEOUT_MS`).
- **Browser** capacity is bounded by `BROWSER_POOL_CONCURRENCY`; use a remote CDP sidecar for scale.
- **Rate limiting** is per-identity via `RATE_LIMIT_MAX`; front with an edge limiter for defense in depth.
