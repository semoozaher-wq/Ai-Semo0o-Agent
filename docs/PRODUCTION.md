# Production Guide & Readiness Matrix — Ai-Semo0o-Agent

This document is the authoritative reference for running Ai-Semo0o-Agent in production: the
configuration contract, secret handling, the **fail-closed** semantics, the **Production Readiness
Matrix**, the external credentials each capability needs, and the go-live checklist.

> The evidence behind every row is recorded in
> [`FINAL_ENGINEERING_REPORT_P5.md`](FINAL_ENGINEERING_REPORT_P5.md),
> [`FINAL_ENGINEERING_REPORT_P6.md`](FINAL_ENGINEERING_REPORT_P6.md), and
> [`FINAL_ENGINEERING_REPORT_P7.md`](FINAL_ENGINEERING_REPORT_P7.md). The machine-readable
> real-provider run is in [`real-provider-evidence.json`](real-provider-evidence.json).

---

## 1. Production configuration contract

`assertEnv()` (`backend/config/env.mjs`) runs before the server binds a port or opens the database.
When `NODE_ENV=production` the process **refuses to start** unless:

| Rule | Error code |
|------|-----------|
| `SECRETS_MASTER_KEY` present and ≥ 32 bytes | `MISSING_SECRETS_MASTER_KEY` / `SECRETS_MASTER_KEY_MUST_BE_32_BYTES` |
| `DATABASE_FILE` present and absolute | `MISSING_DATABASE_FILE` / `DATABASE_FILE_MUST_BE_ABSOLUTE` |
| `WORKSPACE_ROOT` present and absolute | `MISSING_WORKSPACE_ROOT` / `WORKSPACE_ROOT_MUST_BE_ABSOLUTE` |
| `ALLOWED_ORIGIN` set and not `*` | `ALLOWED_ORIGIN_WILDCARD_FORBIDDEN` |
| If `BILLING_PROVIDER` set → `BILLING_WEBHOOK_SECRET` ≥ 16 bytes | `BILLING_WEBHOOK_SECRET_REQUIRED` / `_TOO_SHORT` |
| If `BROWSER_CDP_URL` set → `ws://` or `wss://` | `BROWSER_CDP_URL_INVALID` |

Warnings (non-fatal, surfaced without leaking values): `NO_LLM_PROVIDER_CONFIGURED`,
`ALLOWED_ORIGIN_NOT_SET`, `TAVILY_API_KEY_EMPTY`, `BROWSER_LAUNCH_LOCAL_IN_PROCESS`
(in-process Chromium runs with `--no-sandbox`), `BROWSER_CDP_URL_NOT_TLS` (a remote
plaintext `ws://` CDP endpoint is unauthenticated), `LOG_FORMAT_NOT_SET` (neither `LOG_FORMAT`
nor `LOG_LEVEL` is set, so structured request logging is disabled — see §8).

---

## 2. Fail-closed semantics

A capability is **fail-closed** when the absence of its credential makes the tool either *not
registered* (`GET /tools/status` → `unwired`) or *throw* (`*_REQUIRED`) — never a silent success.
This is the core anti-mock guarantee:

- `image.generate` / `image.analyze` → `unwired` unless an image/vision provider key is set.
- `email.send` → `unwired` unless `EMAIL_FROM` + (Postmark or SMTP) is set.
- `calendar.schedule` → `unwired` unless CalDAV/webhook/ICS dir is set.
- `browser.run` / `browser.extract` → `unwired` unless a Chromium/CDP endpoint resolves.
- `github.oauth.*` → `unwired` unless `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` are set.
- LLM-dependent paths (`/chat`, `/chat/stream`, `agent.run`) → throw `NO_SERVER_LLM_PROVIDER_CONFIGURED`
  when no LLM key is configured.

---

## 3. Production Readiness Matrix

Legend: **DONE** = implemented, wired, tested, and proven against the real external runtime;
**PARTIAL** = some sub-parts proven real, others still gated on a credential; **UNCONFIGURED** = code
complete and contract-tested, but the live provider credential is absent in this environment;
**BLOCKED** = cannot proceed without external input; **FAILED** = broken.

| # | Capability | Implementation | Runtime wiring | Automated tests | Live / real execution (P6) | Status |
|---|-----------|:--:|:--:|:--:|:--:|:--:|
| A | Image generation + vision analysis | ✅ | ✅ | ✅ contract (mock HTTP round-trip) | ⚪ key absent (harness ready) | **UNCONFIGURED** |
| B | Full web browser (CDP) | ✅ | ✅ | ✅ real Chromium | ✅ real Chromium in tests | **DONE** |
| C | File intelligence (PDF/DOCX/XLSX/…) | ✅ | ✅ | ✅ real fixtures | ✅ real fixtures | **DONE** |
| D | LLM token streaming (`/chat/stream`) | ✅ | ✅ | ✅ mock stream + live SSE | ⚪ real provider key absent | **PARTIAL** |
| E | GitHub lifecycle (clone→…→PR) | ✅ | ✅ | ✅ real bare-repo + mock API | ✅ **real network clone/edit/diff/commit**; push/PR gated | **DONE / PARTIAL (push, PR, OAuth)** |
| F | Self-healing loop | ✅ | ✅ | ✅ unit + runtime | ✅ live agent run | **DONE** |
| G | Calendar + Email | ✅ | ✅ | ✅ real mock SMTP + ICS | ✅ **real SMTP via aiosmtpd + real ICS/webhook**; CalDAV/Postmark gated | **DONE / PARTIAL (CalDAV, Postmark)** |
| H | Billing (Stripe) + provider fallback | ✅ | ✅ | ✅ mock Stripe + fallback | ✅ **real webhook HMAC**; Stripe API + real cross-provider fallback gated | **PARTIAL** |
| — | Core HTTP runtime (auth/DB/memory) | ✅ | ✅ | ✅ | ✅ live smoke | **DONE** |
| — | Agent run pipeline (plan→tool→evidence) | ✅ | ✅ | ✅ | ✅ live agent run | **DONE** |
| — | Real status surface (`/ready`,`/tools/status` → UI) | ✅ | ✅ | ✅ `readiness.test.mjs` | ✅ live probes | **DONE** |
| — | Hardened readiness probe (structured `checks`, fail-closed 503) | ✅ | ✅ | ✅ `readiness.test.mjs` | ✅ live 503/200 | **DONE** |
| — | Structured request logging (env-gated telemetry) | ✅ | ✅ | ✅ `readiness.test.mjs` (env warning) | ✅ env-gated | **DONE** |

**Honest summary (updated after P6 real-provider verification):** the *platform* (runtime, agent
pipeline, browser, files, streaming transport, self-healing) is production-ready and proven live.
Two credential-gated integrations are now also proven against the **real external runtime**: GitHub
(a genuine `git clone` from github.com → edit → diff → commit) and Email (a genuine SMTP delivery
into an aiosmtpd server), plus the billing **webhook signature** (real HMAC). The remaining
sub-parts — live image/vision generation, real LLM token streaming, Stripe REST calls, real
cross-provider LLM fallback, GitHub push/PR/OAuth, CalDAV, Postmark — are code-complete and
contract-tested but **UNCONFIGURED** here because no live third-party keys were provided. None of
them fake success — they are fail-closed, and the harness (`scripts/real-provider-verify.mjs`) will
exercise each one for real the moment its credential is present. **Do not call this "Commercial
Production Ready" until those credential-gated sub-parts are proven by real safe execution.**

**P7 update (commercial readiness):** the client now surfaces this exact status — readiness checks,
per-provider health, and the live/unwired split — in **Settings → "حالة النظام والقدرات"**, and the
`/ready` probe fails closed with structured checks. P7 introduced **no new gaps**; the remaining gaps
are the credential-gated sub-parts above plus the operational notes in §6. See
[`FINAL_ENGINEERING_REPORT_P7.md`](FINAL_ENGINEERING_REPORT_P7.md).

---

## 4. Required external credentials

| Capability | Required variables | Where to obtain |
|-----------|--------------------|-----------------|
| LLM (chat/agent/stream) | `OPENAI_API_KEY` **or** `GEMINI_API_KEY` **or** `ANTHROPIC_API_KEY` | provider dashboards |
| Web search | `TAVILY_API_KEY` | tavily.com |
| Image gen | `OPENAI_API_KEY` / `GEMINI_API_KEY` / `STABILITY_API_KEY` | provider dashboards |
| Vision analysis | `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | provider dashboards |
| Email | `EMAIL_FROM` + (`POSTMARK_SERVER_TOKEN` **or** `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`) | Postmark / SMTP host |
| Calendar | `CALDAV_URL` **or** `CALENDAR_WEBHOOK_URL` **or** `CALENDAR_ICS_DIR` | calendar provider |
| GitHub | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` (OAuth); a token for clone/push | GitHub OAuth app |
| Billing | `BILLING_PROVIDER=stripe` + `STRIPE_SECRET_KEY` + `STRIPE_PRICE_PRO` + `BILLING_WEBHOOK_SECRET` | Stripe dashboard |
| Security (required in prod) | `SECRETS_MASTER_KEY` (≥ 32 bytes) | `openssl rand -base64 48` |

---

## 5. Secret handling

- `SECRETS_MASTER_KEY` encrypts tenant secrets at rest (AES-256-GCM). **Store it in a secrets
  manager**; losing it means losing access to stored secrets. Never bake it into an image or commit it.
- `BILLING_WEBHOOK_SECRET` verifies the HMAC signature on `POST /billing/webhook`; without it, a
  production billing deployment will not start.
- The codebase logs environment variable **names**, not values, and the security scan fails the build
  on hardcoded-secret patterns.

---

## 6. Remaining gaps & risks

1. **Live third-party credentials** — the five UNCONFIGURED capabilities need real keys to be proven
   against live providers. Until then they are contract-tested only (honest status, not claimed DONE).
2. **SQLite concurrency** — `node:sqlite` is embedded; for high write concurrency plan a migration to
   a client/server DB. All DB access is isolated in `backend/db/client.mjs`.
3. **Browser scale** — bounded by `BROWSER_POOL_CONCURRENCY`; use a remote CDP sidecar for scale.
4. **Node version** — requires Node ≥ 22.13.0 (`node:sqlite` is experimental and prints a warning).
5. **Optional `typescript` dependency** — the project-intelligence parser degrades to
   `lexical-fallback` when the optional TS parser is unavailable; install dev deps for full fidelity.

---

## 7. Go-live checklist

- [ ] `NODE_ENV=production` with all required vars set (server starts without `ENV_VALIDATION_FAILED`).
- [ ] `SECRETS_MASTER_KEY` stored in a secrets manager and backed up.
- [ ] At least one LLM provider configured (`/ready` shows a healthy provider).
- [ ] `ALLOWED_ORIGIN` set to the exact client origin (not `*`).
- [ ] `DATABASE_FILE` and `WORKSPACE_ROOT` on persistent, backed-up volumes.
- [ ] `npm run typecheck && npm run lint && npm run security:scan && npm test && npm run build` all green.
- [ ] `GET /health` returns `ok:true` with a `version` and non-negative `uptimeSeconds`.
- [ ] `GET /ready` returns `200` with `checks.database.ok`, `checks.workspace.ok`, and
      `checks.providers.ok` all `true` (a `503` means a node must be taken out of rotation).
- [ ] `GET /tools/status` shows the expected `live` set for your configured credentials; confirm the
      client's **Settings → "حالة النظام والقدرات"** card matches it (no capability shown as ready
      that the backend reports as `unwired`).
- [ ] `LOG_FORMAT=json` (or `LOG_LEVEL`) is set so request logging is enabled (avoids
      `LOG_FORMAT_NOT_SET`).
- [ ] Backup/restore rehearsed: `node backend/ops/sqlite-archive.mjs backup|verify|restore`.
- [ ] Billing (if enabled): Stripe webhook endpoint registered with the signing secret.
- [ ] `node scripts/real-provider-verify.mjs` run with production credentials → every capability you
      intend to sell shows **DONE** (no UNCONFIGURED rows for enabled features).
- [ ] Incident runbook and SLOs reviewed (`INCIDENT_RUNBOOK.md`, `SLO_AND_RESTORE_DRILL.md`).
