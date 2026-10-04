

# P3 Final Addendum — 2026-10-04

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
