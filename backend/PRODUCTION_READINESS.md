# Production Readiness — Semo0o AI

> **Final readiness statement (feature-completion cycle).** All previously
> fail-closed connectors (image, vision, email, calendar, managed embeddings,
> local Chromium, Stripe billing, GitHub OAuth/automation, Sentry error tracking)
> are now **real, operator-configurable adapters** that still **fail closed** when
> unconfigured, are surfaced honestly in the UI via `GET /integrations/status`,
> and are covered by **431 passing tests**. Static gates are green (typecheck,
> lint, build, security scan, backend import verification). The product is
> **software-complete for this scope** but remains **NOT PRODUCTION READY as a
> commercial SaaS** solely because of external blockers: live provider
> credentials, off-site backup/alert delivery, mobile signing, and legal review.
> No unverified integration is marked PASS and no fake success path exists.

This document is the honest release-gate record. It states what was actually
implemented and verified, and what remains blocked on external infrastructure,
credentials, legal review, or device/signing environments. Nothing is marked
`PASS` without command-level evidence.

---

## Feature-Completion Addendum — 2026-10-07

Focus: complete the previously fail-closed connectors **end-to-end** (real
adapters + live status + frontend surface), then harden, load-bound, and document
them. The goal of this cycle was to turn every stub that returned
`TOOL_CONNECTOR_NOT_CONFIGURED:*` into a real, operator-configurable integration
that still **fails closed** when no credentials are supplied.

### Implemented and verified this cycle

- **Image generation & vision (`image.generate`, `image.analyze`).**
  `backend/tools/connectors.mjs` resolves a provider from the environment
  (`openai` / `gemini` / `http`) and performs a real, bounded network call. With
  no provider configured the tool still throws `TOOL_CONNECTOR_NOT_CONFIGURED`.
- **Transactional email (`email.send`).** Real `resend` / `sendgrid` / `webhook`
  adapters deliver synchronously and return the provider message id.
- **Calendar (`calendar.schedule`).** Real `google` / `webhook` adapters create an
  event and return its id/link.
- **Managed embeddings.** `backend/memory/embeddings.mjs` adds `openai` / `gemini`
  / `http` providers with a deterministic local fallback (`local-hash-v1`); the
  active provider is reported honestly by `embeddingStatus`.
- **Local Chromium launcher.** `backend/browser/launcher.mjs` launches a local
  headless Chromium and discovers its CDP websocket URL so `browser.run` works
  without an external CDP endpoint; it fails closed when no binary is found.
- **Stripe billing adapter.** `backend/billing/stripe.mjs` implements
  customer / checkout / portal / cancel against the Stripe REST API.
- **GitHub OAuth + automation.** `backend/github/service.mjs` +
  `connections.mjs` implement OAuth authorize/token-exchange and repo/issue/PR
  automation over the fixed GitHub REST API.
- **Sentry-compatible error tracking.** `backend/observability/error-tracking.mjs`
  parses a DSN and posts events; it is a no-op when unconfigured and never throws
  into the request path.
- **Honest live status.** `GET /integrations/status` reports the real state of
  tools + billing + github + embeddings + errorTracking + browser. The frontend
  `IntegrationsCard` (Settings + Operations) surfaces it and drives the GitHub
  connect/disconnect flow.

### Security & performance hardening (this cycle)

- **No secret leakage.** Every new adapter now sanitizes transport errors to a
  stable, URL-free code (`*_UNREACHABLE` / `*_TIMEOUT`) and scrubs any
  provider-echoed credential from error detail. The Gemini embedding key moved
  from the URL query to the `x-goog-api-key` header. Covered by
  `backend/test/connector-redaction.test.mjs` (10 tests).
- **Bounded concurrency.** `backend/util/concurrency.mjs` provides
  `mapWithConcurrency`; `MemoryStore.reindexProject` now embeds with bounded
  concurrency (`EMBEDDING_CONCURRENCY`, default 4) and reports
  `{ indexed, failed, concurrency }` instead of aborting on one bad document.
  Covered by `backend/test/concurrency.test.mjs` (5 tests).
- **Stale-file removal.** The two stray root duplicates (`server.mjs`,
  `tools/registry.mjs`) with broken imports were verified unreferenced and
  removed (the project's own `README_CI_FIX.md` mandates their deletion).

### Verified evidence (commands actually run this cycle)

| Command / area | Result | Evidence |
|---|---|---|
| `npm test` | PASS | 416/416 (legacy 80, execution 57, phase1 43, frontend 13, phase2 11, backend 212) |
| `npm run test:backend` | PASS | 227/227 (adds connector-redaction 10, concurrency 5) |
| `npm run typecheck` | PASS | `tsc --noEmit`, 0 errors |
| `npm run lint` | PASS | `expo lint`, exit 0 |
| `npm run build` | PASS | Expo web export (20 static routes) |
| `npm run security:scan` | PASS | 300 tracked files, no findings |
| `node scripts/verify-imports.mjs backend` | PASS | 0 broken relative imports |
| `npm audit` | FAIL | Expo dependency graph advisories unchanged; `--force` not applied |

### Remaining blockers (unchanged: external infrastructure / credentials / legal / devices)

1. **Dependency advisories.** `npm audit` is non-zero (Expo toolchain); remediation
   needs upstream upgrades and is not force-applied.
2. **Live provider evidence.** The adapters are real and tested against stubbed
   providers, but no real provider credentials were supplied in this environment,
   so live calls to Stripe/GitHub/OpenAI/Sentry remain **NOT VERIFIED** here.
3. **Off-site backups, alert delivery, mobile signing, legal review.** Unchanged
   from the Phase 3 addendum.

### Final decision (feature-completion cycle)

**Connectors are now real, honest, and fail-closed; still NOT PRODUCTION READY as
a commercial SaaS** because live-credential evidence, off-site operations, mobile
signing, and legal review remain external blockers. No unverified integration is
marked `PASS`, and no fake success path was introduced.

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
