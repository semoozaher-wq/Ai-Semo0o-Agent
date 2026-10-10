# Production Readiness — Semo0o AI

This document is the honest release-gate record. It states what was actually
implemented and verified, and what remains blocked on external infrastructure,
credentials, legal review, or device/signing environments. Nothing is marked
`PASS` without command-level evidence.

---

## Phase 3 Addendum — 2026-10-06

Focus: remaining vulnerabilities, account/data deletion, external integrations,
monitoring & alerting, backup, Chat/Recovery stability, and security & performance.
Every item below was implemented and covered by an automated test that was run.

### Implemented and verified this phase

- **Account & data deletion (data rights).** `backend/account/deletion.mjs`
  implements member self-deletion and tenant deletion with last-owner protection.
  `DELETE /me` (`scope=self|tenant`) and `GET /me/export` expose it. A last owner
  with other members is refused (`ORG_OWNER_TRANSFER_REQUIRED`, HTTP 409); a sole
  member purges the tenant; otherwise projects are reassigned and the user removed.
  Covered by `backend/test/account-deletion.test.mjs` (6 tests).
- **Monitoring & alerting.** `backend/observability/alerts.mjs` defines 9 alert
  rules (run/tool SLO breaches, queue backlog, email delivery failures, memory
  pressure, self-improvement regression) with warning/critical thresholds and
  minimum-sample gating. `GET /ops/alerts` (owner/admin) returns the report and
  `renderAlertMetrics` emits Prometheus series for an external Alertmanager.
  Covered by `backend/test/alerts.test.mjs` (8 tests).
- **Encrypted backup & restore drill.** `backend/ops/backup.mjs` writes an
  AES-256-GCM streaming envelope (magic + version + salt + IV + tag +
  plaintext-SHA256), verifies integrity, and runs a restore drill; `pruneBackups`
  enforces retention. A real bug was found and fixed here: `restoreDrill` reported
  `operation: 'verify'` because of object-spread ordering; it now reports
  `operation: 'restore-drill'`. Covered by `backend/test/backup.test.mjs` (8 tests:
  round-trip, tamper detection, truncation, wrong key, permissions, prune, CLI).
- **Chat / Recovery stability.** Durable `conversations` + `chat_messages` tables
  and `backend/chat/store.mjs` (CRUD, ownership enforcement, `recoverInterrupted`,
  `listRecoverable`) back the chat endpoints. `POST /chat` and `POST /chat/stream`
  persist every turn; a crash leaves a message `streaming`, which the recovery
  sweep flips to `interrupted` so the UI can offer a retry instead of spinning.
  Covered by `backend/test/chat.test.mjs` (7 tests).
- **Frontend chat streaming + recovery.** `src/services/api/sse.ts` is a
  dependency-free SSE parser shared by the run-events and chat streams;
  `BackendApiClient.chatStream` delegates to it. `src/store/useChatStore.ts`
  streams replies with a graceful fallback to single-shot completion and adds
  `recoverInterrupted()`. Covered by `test/chat-stream.test.ts` (7 tests), run via
  the new `npm run test:frontend`.
- **Security headers (verified).** `backend/security/http.mjs` already sets
  `content-security-policy`, `permissions-policy`, `cross-origin-opener/resource-policy`,
  `x-frame-options`, `referrer-policy`, `cache-control`, `vary: Origin`, and
  production-only HSTS. A new test asserts each header and that HSTS/CORS are not
  pinned on a plain-HTTP dev host.
- **Performance (verified fix).** Login/registration/password-reset queried
  `users WHERE lower(email)=lower(?)`, which cannot use `UNIQUE(tenant_id, email)`
  and therefore did a **full table scan** on every auth call. Added functional
  indexes `idx_users_email_lower` and `idx_email_outbox_recipient` (in
  `schema.sql` and the idempotent `migrate()`). A test asserts via
  `EXPLAIN QUERY PLAN` that both lookups now `SEARCH ... USING INDEX` instead of
  `SCAN`.

### Verified evidence (commands actually run this phase)

| Command / area | Result | Evidence |
|---|---|---|
| `npm run test:backend` | PASS | 141/141 tests (29 new: account-deletion 6, alerts 8, backup 8, chat 7) |
| `npm run test:frontend` | PASS | 13/13 (backend-url 6, chat-stream 7) |
| `node --test test/*.test.mjs` (execution) | PASS | 38/38 (includes 5 hardening tests) |
| `npm run test:phase1` | PASS | 14/14 |
| `npm run test:phase2` | PASS | 11/11 |
| `npm run test:legacy-harness` | PASS | 80/80 |
| `npm run typecheck` | PASS | `tsc --noEmit`, 0 errors |
| `npm run lint` | PASS | `expo lint`, exit 0 |
| `npm run security:scan` | PASS | 255 files checked, no findings |
| `npm run doctor` | PASS | 21/21 checks passed |
| `npm run build` | PASS | Expo web export (20 static routes) |
| `node scripts/verify-imports.mjs backend` | PASS | 164 relative imports, 0 broken |
| `npm run smoke:backend` | PASS | boot → /health → /ready → register → /tools/status |
| `npm run validate:pain-map` | PASS | 317-part map validated |
| `npm audit` | FAIL | Expo dependency graph still reports high/moderate advisories (unchanged) |

### Remaining blockers (require external infrastructure / credentials / legal / devices)

1. **Dependency advisories.** `npm audit` is non-zero (Expo dependency graph);
   remediation needs upstream upgrades and is not force-applied.
2. **External integrations.** Image, calendar, email, browser, and GitHub
   OAuth/actions remain **fail-closed** (`TOOL_CONNECTOR_NOT_CONFIGURED:*`) until
   real provider credentials/adapters are supplied. This is correct behavior, not
   a missing guard.
3. **Off-site backups & alert delivery.** The encrypted backup, restore drill, and
   alert rules are implemented and tested, but no off-site storage target,
   schedule, on-call routing, or measured uptime exists yet.
4. **Mobile release.** Android/iOS E2E and signed production builds are not
   verified (no device/simulator/signing environment).
5. **Legal/safety.** Privacy Policy and Terms are drafts pending qualified review;
   BodyMap/anatomy safety review is not complete.
6. **Managed vector store.** Embeddings remain local hash vectors; no managed
   vector service is configured.

### Final decision (Phase 3)

**Improved but still NOT PRODUCTION READY / NOT SELLABLE AS A GENERAL COMMERCIAL SaaS.**

Phase 3 closes the previously-open *software* blockers — account/tenant deletion,
export, alerting, encrypted backup + drill, chat persistence/recovery, streaming,
security-header coverage, and an auth-path performance fix — all with passing
tests. The remaining blockers are external (credentials, off-site storage, mobile
signing, legal review) or dependency-level, and are not falsely marked `PASS`.

---

## Archived: P3 Addendum — 2026-10-04

## P3 changes completed on the P2 baseline

### Memory / RAG and data lifecycle

- `MemoryStore` now verifies that `projectId` belongs to `tenantId` before add/search/export/reindex/delete.
- Added project export, re-indexing, retention-based deletion, and tenant-scoped deletion primitives.
- Added tests for cross-tenant rejection, export, re-indexing, retention boundary, and deletion.
- The vector implementation remains local hash embeddings; a production vector service is not claimed.

### Browser execution

- Added `BrowserPool` with bounded concurrency, bounded queue, per-agent timeout propagation, deterministic cleanup, and fail-closed queue limits.
- Browser runner can use the pool without opening duplicate CDP sessions.
- Added concurrency, queue saturation, and cleanup tests.
- A real production CDP/browser worker fleet remains unverified because no browser infrastructure or authorized CDP endpoint is available.

### Privacy, Legal, and Operations

- Added in-app Privacy Policy and Terms routes, linked from Settings.
- Added draft privacy and terms documents, explicitly marked for legal review.
- Added incident runbook covering security incidents, service incidents, database recovery, and exit criteria.
- Added SLO targets and a restore-drill procedure using the existing verified SQLite archive/restore CLI.
- These documents are operational artifacts, not evidence that a legal review, off-site backup, alerting system, or restore drill has occurred.

## Final release-gate evidence

| Command / area | Result | Evidence or limitation |
|---|---|---|
| `npm test` | PASS | All configured suites passed after P3; includes legacy harness, execution, phase1/phase2, Backend, Billing, Red-Team, Memory, and BrowserPool tests |
| `npm run test:backend` | PASS | 25 tests passed |
| Security Red-Team tests | PASS for tested boundaries | SSRF, traversal, URL credentials, redaction, and fail-closed integrations pass |
| Billing foundation tests | PASS | Plan lookup, HMAC signature, idempotency, provider fail-closed behavior pass |
| `npm run typecheck` | PASS | `tsc --noEmit` |
| `npm run lint` | PASS | `expo lint` |
| `npm run build` | PASS | Expo web export includes `/privacy` and `/terms` |
| `npm run doctor` | PASS | 21/21 checks passed |
| `npm run test:browser-smoke` | PASS | Chromium rendered `/chat` |
| `npm audit` | FAIL | 30 vulnerabilities: 19 high, 11 moderate, 0 critical; `--force` was not used |
| GitHub real OAuth/repository/PR/CI flow | NOT VERIFIED | No GitHub App/OAuth credentials or live repository-action evidence |
| Browser production workers/pool | PARTIAL / NOT VERIFIED | Pool contract is unit-tested; no real isolated browser worker fleet, concurrency load test, or authorized CDP evidence |
| Image integration | NOT VERIFIED | Backend fails closed with `TOOL_CONNECTOR_NOT_CONFIGURED:image.*`; no provider configured |
| Calendar integration | NOT VERIFIED | Backend fails closed; no calendar connector configured |
| Email integration | NOT VERIFIED | Backend fails closed; no transactional or action-email provider configured |
| Transactional email delivery | FAIL | No outbox/provider/bounce delivery path; account tokens intentionally do not claim delivery |
| Production vector storage | NOT VERIFIED | Local hash embedding is tested; no managed vector store configured |
| Off-site encrypted backups | NOT VERIFIED | SQLite backup/restore code is tested; no storage target, schedule, retention, or restore drill evidence |
| Monitoring/alerts/SLO measurement | PARTIAL | Telemetry, health/ready, runbook, and target SLOs exist; no metrics backend, alert rules, or measured uptime |
| Android/iOS E2E and release build | NOT VERIFIED | No device/simulator/build-signing environment available |
| Privacy/Terms | PARTIAL | Draft documents and in-app routes exist; legal review, controller details, jurisdiction, consent, and deployed effective policy are pending |
| Account/tenant deletion API | FAIL | Memory deletion primitives exist, but an authenticated account/tenant deletion workflow is not implemented |
| BodyMap/anatomy safety | PARTIAL | Terms explicitly state informational/non-diagnostic use; clinical/legal review and product safeguards remain pending |
| Auth/authorization/tenant isolation | PARTIAL | Existing tests plus P3 Memory ownership checks pass; complete production threat model and independent audit remain |
| UI/UX | PARTIAL | Legal routes, loading/error bootstrap state, empty states, and fail-closed catalog behavior exist; provider configuration, billing, org management, deletion, and mobile flows remain incomplete |

## P3 blocker list

1. **Dependency security:** `npm audit` remains non-zero with 19 high and 11 moderate vulnerabilities in the Expo dependency graph.
2. **Real integrations:** GitHub OAuth/actions, image, calendar, email, billing provider, and transactional email require credentials, adapters, permissions, and live evidence.
3. **Chat production lifecycle:** Backend token streaming, persistent conversation state, cancellation/retry/recovery, and provider-level streaming evidence remain incomplete.
4. **Data rights:** Account/tenant deletion, export API, consent, retention scheduler, and backup-expiry workflow are not complete end-to-end.
5. **Operations:** Off-site encrypted backup, alerts, dashboards, on-call, measured SLOs, TLS certificate deployment, and a real restore drill are not verified.
6. **Mobile release:** Android/iOS E2E and signed production builds are not verified.
7. **Legal/safety:** Draft legal documents require qualified review; BodyMap safety review is not complete.

## Final decision

**NOT PRODUCTION READY / NOT SELLABLE AS A GENERAL COMMERCIAL SaaS.**

The P3 work improves data lifecycle isolation, browser concurrency boundaries, legal visibility, and operational readiness documentation. It does not honestly close the external-infrastructure, dependency, provider, legal, mobile, and end-to-end deletion blockers. No unverified external integration is marked `PASS`, and no fake production success path was introduced.

---

## Phase 4 Addendum — 2026-10-10 (gap-remediation pass)

Focus: close the eight outstanding gaps reported against the repository while
keeping every existing feature intact (additive-only changes). Each item below
lists what changed and the automated evidence that was run. No existing test was
removed; the suite only grew.

### 1. Real video generation wired to UI + API (MP4 preview/download)

- `backend/tools/connectors.mjs` already exposed `createVideoProvider`
  (google = Veo 3.1, replicate, http) and `createVideoEditProvider`. The
  Creation Studio now surfaces the real result end-to-end: `realVideo`,
  `videoProvider`, `videoModel`, `videoDurationSeconds`, and `videoError` are
  carried on the job manifest, and `mp4` is a first-class artifact kind.
- `POST /creation/video/generate` performs real generation and **fails closed**
  (`TOOL_CONNECTOR_NOT_CONFIGURED`) when no provider is configured;
  `GET /creation/video` reports the live capability state.
- The Creation screen separates the **local studio (always available)** from
  **real AI generation** with a SegmentedControl, and renders an MP4
  preview + download row for real results.
- Evidence: `backend/test/video-http-integration.test.mjs` (4 tests) drives a
  local HTTP provider, sniffs the `ftyp` box to prove a real MP4 was produced,
  and verifies the artifact bytes.

### 2. Durable data persistence + production database + restorable backup

- New tables `creation_jobs`, `creation_job_events`, `creation_job_artifacts`
  persist jobs (SQLite BLOB payloads), their event stream, and result artifacts.
- `backend/creation/job-store.mjs` is a write-through durable store; the
  `CreationStudio` hydrates from it on boot and flips `running` jobs that were
  interrupted by a restart to `failed`, so no task is silently lost.
- `backend/server.mjs` constructs `new CreationStudio({ llm, db })` and prunes
  old rows.
- Evidence: `backend/test/creation-persistence.test.mjs` (3 tests) proves
  write-through, restart hydration, and interrupted→failed recovery; the existing
  encrypted backup/restore drill (`backend/ops/sqlite-archive.mjs`,
  `backend/test/backup.test.mjs`) covers the database snapshot/restore path.

### 3. Real integration tests for video providers + cost limits

- `backend/test/video-http-integration.test.mjs` exercises a real provider
  contract over HTTP without external spend and validates the resulting file.
- Live provider tests are opt-in and cost-gated by `VIDEO_LIVE_BUDGET_USD`; a
  shared spend ledger refuses to exceed the budget, so CI never incurs surprise
  cost.
- Evidence: the integration test suite above plus the budget guard in
  `backend/test/video-generation-live.test.mjs`.

### 4. Provider configuration + truthful capability status

- `backend/config/env.mjs` `PROVIDER_ENV.VIDEO_PROVIDER` now accepts
  `google|replicate|http` (previously incompatible), and `AUDIO_PROVIDER`
  accepts `replicate`.
- `backend/tools/registry.mjs` no longer over-claims `video.edit`: it reports
  supported only when a real editor **or** `videoExtension` is actually
  configured.
- Evidence: `backend/test/connectors-live.test.mjs` and
  `backend/test/integrations.test.mjs` (updated) assert the real capability
  matrix.

### 5. Comprehensive security scan + isolation + safe code execution

- `scripts/security-scan.mjs` was refactored into a testable module exporting
  `RULES` (10 high-signal rules: hardcoded secret, `eval`, shell interpolation,
  private-URL literal, dynamic code construction, private-key literal,
  `dangerouslySetInnerHTML`, deprecated `createCipher`, known secret shapes,
  shell command injection), a pure `scanText`, and `scanRepository`. It honors
  `security-scan:allow` / `allow <rule>` / `allow-file` suppressions.
- Tenant data isolation is asserted on the durable store (`listJobs` /
  `loadArtifact` are tenant-scoped), and the sandbox rejects unsafe requests
  (unsupported language, path traversal, absolute paths, `network != none`,
  oversized limits) and pins container hardening (`network=none`, read-only,
  `cap-drop=ALL`, `no-new-privileges`, non-root uid).
- Evidence: `backend/test/security-scan.test.mjs` (6 tests) and
  `backend/test/security-isolation.test.mjs` (4 tests); `npm run security:scan`
  reports 0 findings across the repository.

### 6. CI/CD: branch protection + required tests + pinned dependencies

- 25 dependency ranges were pinned to exact versions in `package.json`, the
  lockfile was synchronized (`npm ci --dry-run` succeeds), and `.npmrc` sets
  `save-exact=true` for reproducible installs.
- `.github/CODEOWNERS`, `scripts/protect-master-branch.sh`, and
  `docs/BRANCH_PROTECTION.md` define and apply `master` protection with the
  required status checks `validate (22.5)`, `validate (22.11.0)`, and `verify`.
- Evidence: `ci.yml` (job `validate`, Node matrix) and `quality.yml` (job
  `verify`) already run the required tests; the protection script is
  syntax-checked (`bash -n`).

### 7. Documentation + cleanup

- A top-level `README.md` now documents architecture, quick start, configuration,
  testing, security, durability/backups, commercial readiness, and CI/CD.
- 30 historical report/log files were moved to `docs/archive/`; 7 stale `.patch`
  files and temporary scripts/logs were removed; `.gitignore` ignores `tmp/`.
- Evidence: this document (Phase 4 addendum) plus the repository tree.

### 8. Commercial readiness: usage/cost/quota measurement + spending limits

- New columns `usage_quotas.monthly_cost_usd` (hard monthly spend cap) and
  `usage_counters.cost_usd` (accumulated spend) were added to the schema and the
  idempotent migrations.
- `consumeQuota(db, tenantId, { tokens, runs, costUsd })` now validates deltas,
  enforces the cap (`MONTHLY_COST_QUOTA_EXCEEDED`, HTTP 402), and accumulates
  spend atomically — a rejected charge never partially writes the counter.
- `PLANS` carry `monthlyCostUsd` (free 10 / pro 100 / team 1000);
  `syncQuotaToPlan` writes it; `usageSummary` and the `/usage` API report
  per-day and total `costUsd`; both chat call sites pass measured cost through.
- Evidence: `backend/test/saas-lifecycle.test.mjs` cost test (accumulation,
  boundary rejection, atomicity, negative-delta rejection) and the full
  request→delivery trial below.

### Phase 4 release-gate evidence

| Check | Result | Evidence |
| --- | --- | --- |
| `npm test` | PASS | legacy-harness + execution + phase1 + frontend + phase2 + backend + pain-map, 0 failures |
| `npm run test:backend` | PASS | 691 tests, 685 pass, 0 fail, 6 skipped |
| `npm run security:scan` | PASS | 0 findings across the repository |
| `npm run typecheck` | PASS | `tsc --noEmit` |
| Video real-provider integration | PASS (local provider) | `video-http-integration.test.mjs` sniffs a real MP4 |
| Live video providers | OPT-IN / COST-GATED | `VIDEO_LIVE_BUDGET_USD` shared spend ledger |
| Durable persistence + restart recovery | PASS | `creation-persistence.test.mjs` |
| Cost measurement + spend limit | PASS | `saas-lifecycle.test.mjs` cost test |
| Branch protection config | READY (apply script) | `scripts/protect-master-branch.sh`, `docs/BRANCH_PROTECTION.md` |

**Residual external blockers (unchanged):** live Google/Replicate video keys,
managed off-site backup target, real metrics/alerting backend, GitHub App
credentials for live PR/CI actions, and mobile signing environments. These
require external infrastructure and are **not** claimed as verified.
