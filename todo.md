# Task: Make Ai-Semo0o-Agent genuinely Production-Ready (close real gaps, prove with real tests)

Baseline (verified before changes): working tree clean; `npm test` green; typecheck/lint/security/audit green;
capability scorecard 94/100 (11 proven, 1 wired, 1 partial); agent bench 4/4; browser E2E 3/3.

Genuine, code-confirmed gaps (not flag-only):
- [x] Auth/MFA: `setupMfa`/`confirmMfa` existed in the client but had ZERO UI wiring.
- [x] Privacy/Data-rights: backend `DELETE /me` + `GET /me/export` existed with tests, but NO client
      methods and NO UI. No `GET /me` to read MFA state (needed for honest UI).
- [x] Capability `self-healing`: PROOF_MAP null -> could never be `proven`; no E2E scenario.
- [x] Capability `integrations`: PROOF_MAP null -> could never be `proven`; no E2E scenario.

## 1. Backend: account profile + MFA/export wiring
- [x] Add `GET /me` returning profile incl. `mfaEnabled` (honest MFA state for the UI)
- [x] Add real HTTP E2E test `backend/test/mfa-lifecycle.test.mjs` (setup->confirm->login MFA->recovery)
- [x] Root-cause fix: `SECRETS_MASTER_KEY_REQUIRED` now maps to an actionable 503 (was a masked 500)

## 2. Frontend: MFA + data-rights wiring (real, testable)
- [x] `src/services/account/security.ts` — pure helpers (otpauth URL, code normalize, export filename/summary, delete confirmation)
- [x] `src/services/account/api.ts` — account operations over injected request (single wire-contract source)
- [x] `src/services/api/client.ts` — add `getAccount`, `deleteAccount`, `exportAccount`; extend `setupMfa` type
- [x] `src/store/useAccountStore.ts` — wire client
- [x] `src/components/composite/AccountSecurityCard.tsx` — MFA + export + delete UI
- [x] `src/screens/Settings.tsx` — render the card
- [x] `test/account-security.test.ts` — real tests for helpers + client<->backend contract
- [x] Wire test into `package.json` test:frontend

## 3. Prove self-healing + integrations end-to-end
- [x] `scripts/agent-benchmark.mjs` — add `self-healing` scenario (real repair) + `integrations` scenario (real local HTTP connector)
- [x] `backend/ops/capability-benchmark.mjs` — PROOF_MAP rules + normalizeProof scenarios
- [x] Update `backend/test/capability-benchmark.test.mjs` (13 proven) + `backend/test/agent-benchmark.e2e.test.mjs` (6-scenario RESULT)

## 4. Verify
- [x] `npm test` green (69 + 43 + 30 + 23 + 301, 0 fail); typecheck; lint; security:scan; audit:gate
- [x] agent benchmark 6/6 scenarios passed=true; capability scorecard 100/100 (13 proven)
- [x] browser E2E still green (3/3; needs BROWSER_NO_SANDBOX=true as root — environmental)

## 5. Deliver
- [x] MODIFIED / ADDED / DELETED / TEST RESULTS / REMAINING / PRODUCTION STATUS
- [x] ZIP of ONLY changed files at original paths, verified == git diff (no build/cache/node_modules)
