# Semo0o AI

**Integrated autonomous AI agent platform** — agents, chat, a creation studio,
operations, and a data engine in one deployable product.

Semo0o AI is a full-stack, multi-tenant platform: an Expo / React Native client
(web + iOS + Android) backed by a hardened Node 22 API and a durable, queue-driven
agent runtime. It ships real tools (code execution in a sandbox, web search,
document/PDF extraction, media generation, GitHub automation), a **Creation
Studio** that turns a brief into a storyboard and a rendered deliverable, and an
operations layer with billing, quotas, monitoring, backups, and a self-improvement
loop.

- **Version:** 2.0.0 (private)
- **Runtime:** Node.js `>=22.5.0` (uses the built-in `node:sqlite`), npm `>=10.9.0`
- **Client:** Expo SDK 57 · React Native 0.86 · React 19 · TypeScript · Zustand · expo-router
- **Backend:** Node 22 (`node:sqlite`), a durable run queue, a supervised worker

---

## Table of contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Running the backend and worker](#running-the-backend-and-worker)
- [Testing](#testing)
- [Security](#security)
- [Data durability and backups](#data-durability-and-backups)
- [Commercial readiness](#commercial-readiness)
- [CI/CD and branch protection](#cicd-and-branch-protection)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

| Area | Capability |
| --- | --- |
| **Agents** | Single-agent and multi-agent runs, a `TaskGraph` for coordinated work, long-running continuations, reflection/lessons across runs, and a runtime planner. |
| **Chat** | Streaming chat with recovery, model routing across providers, and memory. |
| **Creation Studio** | Brief → storyboard → prompt-smith → produce → critic → improve → compose → deliver. Produces GIF, AVI, a bundle, and (when a real provider is configured) a real **MP4**. |
| **Tools** | Sandboxed code execution, web search (Tavily), document/PDF extraction, media generation (image/audio/video), GitHub automation, memory, and more. |
| **Operations** | Durable run queue + supervised worker, approvals/pause/resume/cancel, billing, usage quotas, monitoring & alerts, audit, and encrypted backups. |
| **Self-improvement** | Signals → analysis → approval → monitoring → automatic fail-closed rollback. |

## Architecture

```
┌────────────────────────────┐        ┌──────────────────────────────────────────┐
│  Expo / React Native app   │  HTTPS │  backend/server.mjs  (Node 22, node:sqlite)│
│  (web · iOS · Android)     │ ─────▶ │  auth · projects · runs · tools · creation │
│  src/ · app/               │        │  billing · quotas · observability · ops    │
└────────────────────────────┘        └───────────────┬──────────────────────────┘
                                                       │ durable queue
                                                       ▼
                                      ┌──────────────────────────────────────────┐
                                      │  backend/worker.mjs  (supervised)          │
                                      │  run kinds: agent · code · creation …      │
                                      └──────────────────────────────────────────┘
                                                       │
                        ┌──────────────────────────────┼───────────────────────────────┐
                        ▼                              ▼                               ▼
              execution-core/sandbox.mjs     backend/tools/connectors.mjs     backend/creation/*
              (Docker: no network,           (LLM · image · audio · video ·    (Director + durable
               read-only, cap-drop,           search · github providers)        job store)
               non-root)
```

The client is a thin, typed layer over the REST API (`src/services/api/client.ts`).
The backend owns all state in a single SQLite database (WAL mode) so a backup is
one atomic snapshot. Heavy or long-running work is offloaded to the durable queue
and executed by the worker, which is safe to run as a separate supervised process.

## Quick start

```bash
# 1. Install (reproducible: exact versions + lockfile)
npm ci

# 2. Start the API (loopback by default)
DATABASE_FILE=./.data/agent.sqlite WORKSPACE_ROOT=./.data/workspaces PORT=8787 \
  npm run start:backend

# 3. In another terminal, start the supervised worker
DATABASE_FILE=./.data/agent.sqlite npm run start:worker

# 4. Start the client (Expo)
npm run start          # or: npm run web / npm run android / npm run ios
```

Health and readiness:

```bash
curl -s localhost:8787/health
curl -s localhost:8787/ready
curl -s localhost:8787/tools/status
```

> The backend does **not** read `.env` files. Inject configuration through your
> process supervisor or secret manager (see [Configuration](#configuration)).

## Configuration

All configuration is environment-driven and validated at boot
(`backend/config/env.mjs`). A production boot **fails closed** when a required
secret is missing. The most important variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_FILE` | Absolute path to the SQLite database (forced to mode `0600`). |
| `WORKSPACE_ROOT` | Root for per-project workspaces; project roots are derived, never caller-supplied. |
| `SECRETS_MASTER_KEY` | 32-byte key for the encrypted secret vault. **Required in production.** |
| `BIND_HOST` | Defaults to loopback; set `0.0.0.0` only behind an authenticated TLS proxy. |
| `ALLOWED_ORIGIN` | CORS origin (wildcards are refused). |
| `ALLOW_PUBLIC_REGISTRATION` | Gate for open sign-up; otherwise use `npm run create:admin`. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `GOOGLE_API_KEY` | LLM providers. |
| `TAVILY_API_KEY` | Web search. |
| `VIDEO_PROVIDER` | Real video backend: `google` (Veo) · `replicate` · `http`. |
| `VIDEO_EDIT_PROVIDER` | Video editing backend: `http` · `replicate`. |
| `IMAGE_PROVIDER` / `AUDIO_PROVIDER` / `VISION_PROVIDER` / `STT_PROVIDER` / `TTS_PROVIDER` | Media providers. |
| `BILLING_PROVIDER` / `BILLING_WEBHOOK_SECRET` | Billing integration. |
| `WORKER_CONCURRENCY`, `WORKER_LEASE_MS`, `WORKER_MAX_ATTEMPTS`, … | Queue/worker tuning. |
| `TRIGGER_*` | Trigger scheduler tuning. |

Provider *capability* status is reported honestly by `GET /tools/status`: a tool
is only `ok` when the provider that actually backs it is configured. In
particular `video.edit` is only `ok` when a real editor **or** a video-extension
capability exists — it never reports support it does not have.

## Running the backend and worker

```bash
npm run start:backend     # API server
npm run start:worker      # durable queue worker (run as a separate process)
npm run create:admin      # bootstrap the first admin when public sign-up is off
```

Production runs the API and the worker as separate supervised units; see
`docs/DEPLOYMENT.md` and `render.yaml`.

## Testing

The full suite is the release gate:

```bash
npm test
```

It runs, in order: the legacy harness, the execution tests, phase-1, the frontend
tests, phase-2, the backend suite, and the pain-map validation. To run a single
group:

```bash
npm run test:backend       # node --experimental-sqlite --test backend/test/*.test.mjs
npm run test:frontend
npm run test:phase1
npm run test:execution
```

Live provider tests are **opt-in and cost-gated**: they self-skip unless the
provider key is present, and refuse to spend unless a budget is set. For example:

```bash
VIDEO_LIVE_BUDGET_USD=3 VIDEO_LIVE_COST_USD=1.5 npm run test:backend
```

The scanner, sandbox, and durable-store isolation all have dedicated regression
tests (`backend/test/security-scan.test.mjs`, `security-isolation.test.mjs`,
`creation-persistence.test.mjs`, `video-http-integration.test.mjs`).

## Security

- **SAST / secret scan:** `npm run security:scan` scans every git-tracked
  source/config file for hardcoded secrets and dangerous sinks (`eval`,
  `new Function`, shell interpolation, private keys, `dangerouslySetInnerHTML`,
  deprecated ciphers, known credential shapes). Legitimate occurrences are
  annotated inline with `security-scan:allow <rule>` so every exception is
  visible in review.
- **Dependency audit gate:** `npm run audit:gate` fails on any advisory outside
  the reviewed baseline.
- **Tenant isolation:** every table and every read is tenant-scoped and
  fail-closed, including the durable Creation Studio store.
- **Secure code execution:** `execution-core/sandbox.mjs` runs untrusted code in
  Docker with `--network=none`, `--read-only`, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`, a non-root user, and memory/PID/time limits.
  A bounded in-process VM runner exists for trusted snippets only.

See `docs/CODE_RUN_SANDBOX.md` and `docs/BRANCH_PROTECTION.md`.

## Data durability and backups

All state lives in one SQLite database. The Creation Studio is **write-through**:
jobs, their event logs, and their artifact bytes (with a SHA-256) are persisted as
they are produced, so a restart rehydrates completed work and honestly reports
interrupted work as failed (`CREATION_INTERRUPTED_BY_RESTART`) instead of losing
it. Retention is bounded (age + per-tenant count).

Encrypted backups use `VACUUM INTO` and round-trip jobs and artifact bytes intact:

```bash
npm run db:backup  -- /var/lib/semo0o/agent.sqlite /var/backups/semo0o/agent-2026-10-10.sqlite
npm run db:verify  -- /var/backups/semo0o/agent-2026-10-10.sqlite
npm run db:restore -- /var/backups/semo0o/agent-2026-10-10.sqlite /var/lib/semo0o/restore-candidate/agent.sqlite
```

See `docs/SLO_AND_RESTORE_DRILL.md`.

## Commercial readiness

Usage, cost, and quota are first-class: the platform records per-tenant usage,
applies quotas, and enforces **spending limits** so a runaway job cannot burn
unbounded provider budget. The full request → delivery workflow is exercised by
the production trial (`npm run trial:self-improve`) and the agent benchmark
(`npm run benchmark:agent`).

## CI/CD and branch protection

Two workflows gate every change:

- **`.github/workflows/ci.yml`** — runs the full suite on the Node floor
  (`22.5`) and the deployed runtime (`22.11.0`), plus the dependency-audit gate.
- **`.github/workflows/quality.yml`** — secret/SAST scan, audit gate, import
  verification, typecheck, lint, tests, Expo doctor, web export, browser smoke,
  browser E2E, agent E2E benchmark, backend boot smoke, and the self-improvement
  production trial.

`master` is protected: no direct pushes, one required code-owner approval, linear
history, and the required status checks must pass. Apply the rules with
`scripts/protect-master-branch.sh`; the full policy is in
`docs/BRANCH_PROTECTION.md`. Dependencies are pinned to exact versions and the
lockfile is committed, so builds are reproducible.

## Repository layout

```
app/                 Expo Router routes (tabs, agent, studio, settings, …)
src/                 Client: components, screens, services (typed API client), store, theme
backend/             Node 22 API + worker
  server.mjs           HTTP API (auth, projects, runs, tools, creation, ops)
  worker.mjs           durable queue worker
  db/                  SQLite client + schema (tenant-scoped)
  creation/            Creation Studio: Director + durable job store
  tools/               tool registry + provider connectors
  security/            validators, http hardening
  ops/                 backup / archive / restore
  observability/       metrics + alerts
execution-core/      sandbox (Docker) + code-run adapter + task workspace
phase2-core/         intelligence platform (planning, code intelligence, browser)
shared/              code shared between client and backend
scripts/             CI helpers, security scan, benchmarks, ops tooling
docs/                deployment, security, SLO, branch protection, reports
test/                frontend/phase tests (tsx + node --test)
backend/test/        backend integration tests
```

## Documentation

Start with `docs/` — key entries: `DEPLOYMENT.md`, `PRODUCTION.md`,
`CODE_RUN_SANDBOX.md`, `SLO_AND_RESTORE_DRILL.md`, `BRANCH_PROTECTION.md`,
`INCIDENT_RUNBOOK.md`, `PRIVACY_POLICY.md`, `TERMS_OF_SERVICE.md`. The backend
has its own `backend/README.md` (API outline, archive operations).

## Contributing

See `CONTRIBUTING.md`. In short: branch, keep the change minimal, run
`npm run typecheck` and `npm test`, and open a pull request — `master` requires a
green CI and a code-owner review.

## License

See `LICENSE`.
