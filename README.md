# Ai-Semo0o-Agent (Semo0o AI)

A multi-tenant, Arabic-first AI agent platform: an Expo / React Native client (RTL) talking to a
zero-dependency Node.js backend that plans, executes, verifies, and evidences real work across
files, the web, a real browser, code, images, email, calendar, GitHub, and billing.

> **Status:** `v2.0.0` — Production Hardening (P4), Commercial Product build (P5), Real-Provider
> Runtime (P6), and **Commercial Readiness (P7)** complete. Capabilities that depend on external
> credentials are **fail-closed** and marked `UNCONFIGURED` until real keys are supplied — see
> [`docs/PRODUCTION.md`](docs/PRODUCTION.md) and the Production Readiness Matrix in
> [`docs/FINAL_ENGINEERING_REPORT_P7.md`](docs/FINAL_ENGINEERING_REPORT_P7.md).
>
> The client now surfaces the **real** system status — readiness checks, per-provider health, and the
> live vs. unwired capability split — in **Settings → "حالة النظام والقدرات"**, read directly from
> `GET /ready`, `GET /tools/status`, `GET /models/status`, and `GET /billing/status`. An unavailable
> capability is shown as *not configured*, never as ready.

---

## Why this exists

Most "agent" demos stop at a tool name and a stub. This project holds a stricter bar: **a capability
is only complete when it runs end-to-end against a real provider (or a real local contract server),
is wired into the runtime, is permissioned, handles errors, produces evidence, and passes an
automated E2E test.** Mocks are used *only* as contract tests to prove the request/response shape;
they are never treated as proof that the feature works in production.

---

## Architecture

```
Expo / React Native (app/, src/)  ──HTTP/SSE──►  backend/server.mjs  (node:http, zero-dep)
                                                     │
   auth → tenant/project context → agent engine → planner → permissions/approval gateway
                                                     │
                                          tool registry (backend/tools/registry.mjs)
                                                     │
        ┌────────────┬────────────┬───────────────┬──────────────┬──────────────┐
     LLM router   browser(CDP)   files/extract   image/vision   email/calendar   github   billing
   (OpenAI/Gemini (Chromium)    (PDF/DOCX/XLSX)  (OpenAI/Gemini (SMTP/Postmark) (REST)  (Stripe)
    /Anthropic)                                  /Stability)     /CalDAV
                                                     │
                              evidence → verification → final synthesis → usage/cost accounting
                                                     │
                                        node:sqlite (DatabaseSync)  +  background worker
```

Key design rules:

- **Zero backend dependencies** — only `node:` builtins and relative imports. Requires **Node ≥ 22.5.0**
  for the built-in `node:sqlite` (`DatabaseSync`).
- **Fail-closed providers** — if a provider's credentials are absent, its tool is either not registered
  or throws `*_REQUIRED`; it never fakes success.
- **Permissioned execution** — `DANGEROUS_TOOLS` require an explicit approval event before running.
- **Sandboxed filesystem** — all file/github tools resolve inside `WORKSPACE_ROOT` with symlink-escape
  prevention (`realpathSafe` / `workspacePath`) and SSRF guards (`assertSafeUrlResolved`).
- **Secrets at rest** — tenant secrets encrypted with AES-256-GCM using `SECRETS_MASTER_KEY`.

---

## Capabilities (P5)

| # | Capability | Tools / Routes | Real provider | Status |
|---|-----------|----------------|---------------|--------|
| A | Image generation + analysis | `image.generate`, `image.analyze` | OpenAI Images / Gemini / Stability; OpenAI / Gemini / Anthropic vision | Implemented, contract-tested; live keys `UNCONFIGURED` |
| B | Full web browser | `browser.run`, `browser.extract` | Real Chromium over CDP | Implemented, real-Chromium tested |
| C | File intelligence | `files.extract`, `pdf.extract` | zero-dep ZIP + PDF/DOCX/PPTX/XLSX/CSV/JSON/image | Implemented, real-fixture tested |
| D | LLM token streaming | `POST /chat/stream` (SSE) | OpenAI / Gemini / Anthropic streaming | Implemented, mock-stream tested |
| E | GitHub full lifecycle | `github.*` | git CLI + GitHub REST/OAuth | Implemented, real bare-repo + mock-API tested; OAuth `UNCONFIGURED` |
| F | Self-healing loop | agent runtime | detect→patch→test→verify→rollback | Implemented, unit + runtime tested |
| G | Calendar + Email | `email.send`, `calendar.schedule` | SMTP / Postmark; CalDAV / webhook / ICS | Implemented, real mock-SMTP + ICS tested; live creds `UNCONFIGURED` |
| H | Billing + provider fallback | `/billing/*` | Stripe REST | Implemented, mock-Stripe tested; live key `UNCONFIGURED` |

Full tool list is exposed at runtime via `GET /tools/status` (returns `live`, `unwired`,
`catalogOnly`, `simulated`, `dangerous`, plus an additive `summary` of the counts). The client renders
this split in **Settings → "حالة النظام والقدرات"** so users only ever see capabilities that are
actually wired.

---

## Quick start

```bash
# 1. Requirements: Node >= 22.5.0, npm >= 10.9.0
node --version

# 2. Install
npm install

# 3. Configure
cp .env.example .env
#   - set SECRETS_MASTER_KEY (openssl rand -base64 48)
#   - add at least one LLM key (OPENAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY)
#   - optionally add TAVILY_API_KEY, image, browser, email, calendar, github, stripe keys

# 4. Run the backend (API + in-process worker)
npm run start:backend

# 5. (optional) run the worker separately
DISABLE_WORKER=true npm run start:backend &
npm run start:worker

# 6. Run the mobile/web client
npm start          # Expo dev server
npm run web        # Expo web
```

Health checks: `GET /health` (liveness) and `GET /ready` (readiness).

---

## API surface (selected)

```
POST /auth/register | /auth/login | /auth/logout | /auth/verify-email
POST /auth/request-password-reset | /auth/reset-password
POST /auth/mfa/setup | /auth/mfa/confirm
POST /org/invitations | /org/invitations/accept

POST /projects | GET /projects/:id
POST /projects/:id/documents | GET /projects/:id/search?q= | GET /projects/:id/export | POST /projects/:id/reindex

POST /runs | GET /runs/:id | GET /runs/:id/events (SSE)
POST /runs/:id/cancel | /retry | /pause | /resume | /approval

POST /chat | POST /chat/stream (SSE tokens)

GET  /tools/status | GET /models/status | GET /usage
GET  /billing/status | POST /billing/checkout | /billing/portal | /billing/subscription/cancel
POST /billing/webhook   (HMAC-signed)
GET  /me/export | DELETE /me
GET  /health | GET /ready
```

---

## Testing

The backend suite is pure `node:test` (no network required — real local contract servers are spun up
inside the tests):

```bash
# Backend capability + contract + E2E + readiness suite (108 tests)
npm run test:backend

# Full suite (legacy harness + execution + phase1 + phase2 + backend + pain-map)
npm test

# Quality gates
npm run typecheck       # tsc --noEmit
npm run lint            # expo lint
npm run security:scan   # scripts/security-scan.mjs
npm run build           # expo export --platform web
```

Highlights of the P5–P7 test work:

- `backend/test/e2e-capabilities.test.mjs` — one end-to-end test per capability A–H.
- `backend/test/github-lifecycle.test.mjs` — real `git clone → edit → diff → commit → push` to a local
  bare remote, plus OAuth/PR against a local HTTP mock.
- `backend/test/self-healing.test.mjs` — state-machine unit tests + real agent-runtime healing.
- `backend/test/integrations-email-calendar.test.mjs` — a real mock SMTP server receives a real message.
- `backend/test/files-intelligence.test.mjs` — real DOCX/XLSX/PPTX/PDF fixtures extracted and verified.
- `backend/test/real-provider.test.mjs` — real github.com clone, real aiosmtpd SMTP, real `.ics`/webhook
  (self-skips with a reason when the precondition is absent).
- `backend/test/readiness.test.mjs` — `/health` version+uptime, `/ready` fail-closed 503 with structured
  checks, `/ready` 200 when a provider is healthy, `/tools/status` real summary, and the
  `LOG_FORMAT_NOT_SET` production warning.

---

## Repository layout

```
app/            Expo Router screens (RTL, Arabic-first)
src/            client components, hooks, services, theme
backend/        zero-dependency Node backend (server, agent, tools, integrations)
  agent/        planner, runtime, self-healing state machine
  tools/        live tool registry
  llm/ media/ browser/ files/ github/ integrations/ billing/ secrets/ security/
  test/         node:test suites (capability, contract, E2E)
docs/           deployment, production, runbooks, audit reports
scripts/        security scan, browser smoke, pain-map tooling
```

---

## Required external credentials (production)

Nothing below is required to *run the backend*; each unlocks one capability and is **fail-closed**
until set. See [`docs/PRODUCTION.md`](docs/PRODUCTION.md) for the exact matrix.

- **LLM:** `OPENAI_API_KEY` *or* `GEMINI_API_KEY` *or* `ANTHROPIC_API_KEY`
- **Search:** `TAVILY_API_KEY`
- **Images:** `OPENAI_API_KEY` / `GEMINI_API_KEY` / `STABILITY_API_KEY`
- **Email:** `EMAIL_FROM` + (`POSTMARK_SERVER_TOKEN` *or* `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`)
- **Calendar:** `CALDAV_URL` *or* `CALENDAR_WEBHOOK_URL` *or* `CALENDAR_ICS_DIR`
- **GitHub:** `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` (OAuth); a token for clone/push
- **Billing:** `BILLING_PROVIDER=stripe` + `STRIPE_SECRET_KEY` + `STRIPE_PRICE_PRO` + `BILLING_WEBHOOK_SECRET`
- **Security:** `SECRETS_MASTER_KEY` (≥ 32 bytes) — **required in production**

---

## Documentation

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — environments, provisioning, worker topology, ops
- [`docs/PRODUCTION.md`](docs/PRODUCTION.md) — production config, secrets, readiness matrix
- [`docs/FINAL_ENGINEERING_REPORT_P5.md`](docs/FINAL_ENGINEERING_REPORT_P5.md) — P5 audit with evidence
- [`docs/FINAL_ENGINEERING_REPORT_P6.md`](docs/FINAL_ENGINEERING_REPORT_P6.md) — P6 real-provider runtime
- [`docs/FINAL_ENGINEERING_REPORT_P7.md`](docs/FINAL_ENGINEERING_REPORT_P7.md) — P7 commercial readiness
- [`docs/INCIDENT_RUNBOOK.md`](docs/INCIDENT_RUNBOOK.md) — incident response
- [`docs/SLO_AND_RESTORE_DRILL.md`](docs/SLO_AND_RESTORE_DRILL.md) — SLOs and restore drill
- [`AGENTS.md`](AGENTS.md) — agent/tool authoring guide

---

## License

See [`LICENSE`](LICENSE).
