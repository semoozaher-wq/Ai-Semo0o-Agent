# Phase 4 — Gap Remediation Report

Date: 2026-10-10
Scope: close the eight reported gaps without removing or rewriting any working
feature. Every change is **additive**; the automated suite only grew.

Baseline (before this pass): `npm test` = 667 pass / 0 fail / 6 skipped.
After this pass: backend group = 691 tests / 685 pass / 0 fail / 6 skipped, and
the full `npm test` chain is green.

---

## 1. Video — real generation wired to UI + API, MP4 preview/download

- Real video capabilities (`textToVideo`, `imageToVideo`, `videoExtension`,
  `videoEditing`) are reported through `connectorStatus`; the provider factory
  (`createVideoProvider`) supports `google` (Veo 3.1), `replicate`, and `http`.
- The Creation job manifest now carries `realVideo`, `videoProvider`,
  `videoModel`, `videoDurationSeconds`, and `videoError`; `mp4` is a first-class
  artifact kind surfaced in `creationArtifactUrl` and `useCreationStore`.
- `POST /creation/video/generate` performs real generation and fails closed
  (`TOOL_CONNECTOR_NOT_CONFIGURED`) when no provider is configured;
  `GET /creation/video` reports the live capability state.
- The Creation screen has an explicit SegmentedControl separating the **local
  studio (always available)** from **real AI generation**, plus an MP4
  preview/download row for real results.
- Evidence: `backend/test/video-http-integration.test.mjs` (4 tests) runs a
  local HTTP provider, sniffs the MP4 `ftyp` box, and verifies the artifact.

## 2. Data persistence — durable store + production DB + restorable backup

- New tables `creation_jobs`, `creation_job_events`, `creation_job_artifacts`
  (SQLite BLOB payloads + event stream + result artifacts).
- `backend/creation/job-store.mjs` is a write-through durable store; the
  `CreationStudio` hydrates on boot and flips interrupted `running` jobs to
  `failed` (no silent task loss). `backend/server.mjs` wires
  `new CreationStudio({ llm, db })` and prunes old rows.
- Evidence: `backend/test/creation-persistence.test.mjs` (3 tests) plus the
  existing encrypted backup/restore drill (`backend/ops/sqlite-archive.mjs`,
  `backend/test/backup.test.mjs`).

## 3. Tests — real integration + verified files + cost limits

- `backend/test/video-http-integration.test.mjs` exercises the real provider
  contract over HTTP with no external spend and validates the produced file.
- Live provider tests are opt-in and cost-gated by `VIDEO_LIVE_BUDGET_USD`; a
  shared spend ledger refuses to exceed the budget.

## 4. Providers — `VIDEO_PROVIDER` fix + truthful capability status

- `backend/config/env.mjs`: `PROVIDER_ENV.VIDEO_PROVIDER` accepts
  `google|replicate|http`; `AUDIO_PROVIDER` accepts `replicate`.
- `backend/tools/registry.mjs`: `video.edit` is reported supported only when a
  real editor **or** `videoExtension` is configured (no over-claiming).
- Evidence: `backend/test/connectors-live.test.mjs`,
  `backend/test/integrations.test.mjs`.

## 5. Security — comprehensive scan + isolation + safe code execution

- `scripts/security-scan.mjs` refactored into a testable module: `RULES`
  (10 high-signal rules), pure `scanText`, `scanRepository`, and
  `security-scan:allow` / `allow <rule>` / `allow-file` suppressions.
- Tenant isolation asserted on the durable store; the sandbox rejects unsafe
  requests and pins container hardening (`network=none`, read-only,
  `cap-drop=ALL`, `no-new-privileges`, non-root uid).
- Evidence: `backend/test/security-scan.test.mjs` (6 tests),
  `backend/test/security-isolation.test.mjs` (4 tests); `npm run security:scan`
  = 0 findings.

## 6. CI/CD — branch protection + required tests + pinned dependencies

- 25 dependency ranges pinned to exact versions; lockfile synced
  (`npm ci --dry-run` succeeds); `.npmrc` sets `save-exact=true`.
- `.github/CODEOWNERS`, `scripts/protect-master-branch.sh`, and
  `docs/BRANCH_PROTECTION.md` define/apply `master` protection with required
  checks `validate (22.5)`, `validate (22.11.0)`, `verify`.

## 7. Documentation + cleanup

- Top-level `README.md` added (architecture, quick start, configuration,
  testing, security, durability, commercial readiness, CI/CD).
- 30 historical reports moved to `docs/archive/`; 7 stale `.patch` files and
  temporary scripts/logs removed; `.gitignore` ignores `tmp/`.
- `PRODUCTION_READINESS.md` updated with the Phase 4 addendum.

## 8. Commercial readiness — usage/cost/quota + spending limits

- New columns `usage_quotas.monthly_cost_usd` (hard cap) and
  `usage_counters.cost_usd` (accumulated spend) in the schema + migrations.
- `consumeQuota(db, tenantId, { tokens, runs, costUsd })` validates deltas,
  enforces the cap (`MONTHLY_COST_QUOTA_EXCEEDED`, HTTP 402), and accumulates
  spend atomically (rejected charges never partially write the counter).
- `PLANS` carry `monthlyCostUsd` (free 10 / pro 100 / team 1000);
  `syncQuotaToPlan` writes it; `usageSummary` / `/usage` report per-day and
  total `costUsd`; both chat call sites pass measured cost through.
- Evidence: `backend/test/saas-lifecycle.test.mjs` cost test.

---

## Release-gate evidence

| Check | Result |
| --- | --- |
| `npm test` (full chain) | PASS, 0 failures |
| `npm run test:backend` | PASS — 691 tests / 685 pass / 0 fail / 6 skipped |
| `npm run security:scan` | PASS — 0 findings |
| `npm run typecheck` | PASS |
| Video real-provider integration | PASS (local provider, real MP4) |
| Live video providers | OPT-IN / COST-GATED (`VIDEO_LIVE_BUDGET_USD`) |
| Durable persistence + restart recovery | PASS |
| Cost measurement + spend limit | PASS |
| Branch protection config | READY (apply script) |

## Residual external blockers (not claimed as verified)

Live Google/Replicate video keys, a managed off-site backup target, a real
metrics/alerting backend, GitHub App credentials for live PR/CI actions, and
mobile signing environments. These require external infrastructure.
