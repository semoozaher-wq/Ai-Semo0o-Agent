# Stable Release Hardening — Working Todo

## Phase 0 — Recon
- [x] Clone repo, map architecture (frontend Expo, backend Node, execution-core, phase2-core)
- [x] Read CI/CD workflows, package.json, tsconfig, render.yaml
- [x] Read existing reports to know claimed state (do not trust blindly)

## Phase 1 — Build & Static Verification
- [x] npm ci (install deps)
- [x] npm run typecheck
- [x] npm run lint
- [x] npm run security:scan
- [x] node scripts/verify-imports.mjs backend
- [x] npm run build (web export)

## Phase 2 — Test Suite
- [x] npm run test:execution (69/69)
- [x] npm run test:phase1 (43/43)
- [x] npm run test:frontend (30/30)
- [x] npm run test:phase2 (23/23)
- [x] npm run test:backend (504/504, 0 skipped)
- [x] npm run validate:pain-map
- [x] npm run test:legacy-harness (80/80)
- [x] Full `npm test` green (EXIT=0)

## Phase 3 — Runtime / E2E
- [x] boot-smoke (health/ready/register/tools)
- [x] agent benchmark (100% scenarios)
- [x] capability benchmark (13/13, score 100)
- [x] production trial (self-improve 9/9)
- [x] browser smoke / e2e (chromium available)

## Phase 4 — Reliability & Security verification
- [x] LLM provider failure + fallback
- [x] High-risk tools approval gate
- [x] Queue idempotency / no duplicate execution
- [x] Worker crash/restart recovery
- [x] Multi-agent failures/conflicts/reconciliation + parallel limits
- [x] Evaluation regression detection
- [x] Artifact integrity after storage/reload/restart
- [x] Production startup/health/degraded behavior

## Phase 5 — Fixes
- [x] FIX#1 typecheck: duplicate shims (src/services/store/useAccountStore.ts, src/components/AccountSecurityCard.tsx)
- [x] FIX#2 boot-smoke.sh curl|head SIGPIPE under pipefail
- [x] FIX#3 backend/Dockerfile missing shared/ + jszip runtime dep
- [x] FIX#4 browser-e2e test self-adapts as root (test-only, product policy intact)

## Phase 6 — Deliverables
- [x] Build changes ZIP (new+modified files only, original paths) → /workspace/semo0o-agent-stable-release-changes.zip
- [x] MANIFEST with added/modified/reason/tests/results/blockers → STABLE_RELEASE_MANIFEST.md
- [x] Final report
