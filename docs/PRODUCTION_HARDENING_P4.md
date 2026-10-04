# Production Hardening — P4 Addendum

This addendum records the changes made on top of the P3 baseline. Everything here is implemented and
verified in the repository; nothing is aspirational. Where a capability depends on external infrastructure
that is not provisioned, it is explicitly reported as **Unavailable** rather than faked.

## 1. Correctness fixes

| Area | Before | After |
| --- | --- | --- |
| Chat store import | `useChatStore.ts` imported models from the stale root `data/models.ts`. | Imports from the canonical `src/data/models.ts`. |
| Orchestrator test import | `test/phase1-orchestrator.test.ts` imported tools from the stale root `data/tools.ts`. | Imports from `src/data/tools.ts`. |
| Model catalog typo | `apiModel: 'gemini-3-flash-preview-preview'`. | `apiModel: 'gemini-3-flash-preview'`. |
| Quota race | `consumeQuota` read then wrote counters non-atomically. | Runs inside a single `BEGIN IMMEDIATE` transaction; rejects negative deltas; leaves counters untouched on rejection. |
| Run metering order | `/runs` consumed a run quota before the idempotency check, double-charging replays. | Consumption happens once, after the idempotency check. |
| Chat metering | `/chat` never recorded token usage. | Records `totalTokens` after the LLM call and maps quota errors to HTTP 402. |

## 2. Security hardening

| Area | Change |
| --- | --- |
| Workspace root | `resolveWorkspaceRoot` now fails closed in production (`WORKSPACE_ROOT_REQUIRED`) so a client cannot point a workspace at `/etc`. |
| Sandbox env | The code-execution sandbox no longer inherits the server environment; it builds a minimal, secret-free env (`ENV_ALLOWLIST` + `ENV_DENYLIST`). |
| SSRF | Added `assertSafeUrlResolved` (DNS-resolution-aware) plus an `isPrivateAddress` classifier covering IPv4/IPv6 private, loopback, link-local, CGNAT, and metadata ranges. |
| Symlink escape | Tool-registry `workspacePath` resolves `realpath` for both base and target and rejects escapes; directory listings skip symlinks. |
| Env validation | New `backend/config/env.mjs` validates required production variables and refuses to start on dangerous config. |

## 3. New / wired capabilities

- **`GET /usage`** — tenant-scoped usage series (daily tokens, cost, runs, messages), current-period counters,
  and quota. Powers the analytics screen with real data.
- **`POST /billing/webhook`** — HMAC-verified over the raw body; applies subscription state transitions and
  syncs tenant quota to the effective plan.
- **`browser.run` tool** — wired into the live registry, bounded (≤20 actions/checks), fail-closed when
  `BROWSER_CDP_URL` is unset (reported in `tools/status.unwired`).
- **`.env.example`** — documents every supported variable.

## 4. Frontend honesty (no fake data presented as real)

- `useAnalyticsStore` now fetches the tenant's real usage from `GET /usage` and tracks a `source`
  (`backend` | `local` | `sample`). Demo data is only shown when no backend is configured, and the analytics
  screen renders a **"بيانات تجريبية"** notice in that case.
- `useFilesStore` tracks a `sample` flag; the files screen renders a **"بيانات تجريبية"** notice whenever the
  listing is generated demo data rather than a real workspace scan.

## 5. Accepted dependency risk (documented, not silently ignored)

`npm audit --omit=dev` reports 30 advisories (11 moderate, 19 high). Analysis:

- **All 30 are transitive dependencies of the Expo / React Native build toolchain** (`@expo/cli`, `metro`,
  `@expo/config-plugins`, `xcode`, `@react-native/community-cli-plugin`, `react-native-reanimated`, …).
- The **backend and `execution-core` have zero external runtime dependencies** — verified: every import is a
  `node:` built-in or a relative path. The shipped runtime therefore contains none of these packages.
- The only automated "fix" is `npm audit fix --force`, which downgrades `expo@57 → 44.0.6` and
  `react-native@0.86 → 0.72.17` — a breaking change that would destroy the application. It is **not applied**.
- Most flagged transitive packages are already at their patched releases (`braces@3.0.3`, `micromatch@4.0.8`,
  `decode-uri-component@0.2.2`); npm reports `range: *` because no in-range patched version exists within the
  current Expo major.

**Decision:** accepted, build-time-only risk. Track upstream Expo SDK releases and upgrade when a non-breaking
patched release is available. Re-run `npm run audit:production` on every dependency change.

## 6. Verification (see the final engineering report for full evidence)

| Check | Result |
| --- | --- |
| `npm run typecheck` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm test` | PASS — 80 harness + 35 execution + 14 phase1 + 11 phase2 + 40 backend, 0 failures |
| `npm run security:scan` | PASS — 217 files, no findings |
| `npm run build` | PASS — Expo web export |
| `GET /health` | 200 `{ ok: true }` |
| `GET /ready` | 503 when no LLM provider is configured (correct fail-closed) |
| `GET /usage` (unauth) | 401 |
| `GET /usage` (auth) | 200, tenant-scoped, honest empty state |
