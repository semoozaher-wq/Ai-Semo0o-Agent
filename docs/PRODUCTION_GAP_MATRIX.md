# Ai-Semo0o-Agent — Production Gap Matrix

**Audit date:** 2026-10-03  
**Purpose:** distinguish repository implementation from deployment operations that require a real production host.

## Repository implementation status

| Area | Repository status | Evidence |
|---|---|---|
| Planner → Orchestrator → Tools → Verification | Implemented and regression-tested | Phase 1 orchestrator suite |
| Verification, Evidence, and bounded self-healing | Implemented | Verified/failed/unverified and retry-limit tests |
| Approval and task states | Implemented in runtime, store, and Agents UI | `blocked`, `completed_with_warnings`, `cancelled` mappings and approval tests |
| `code.run` registry boundary | Implemented and fail-closed | Registry integration and sandbox suites |
| Docker sandbox policy | Implemented | Network none, read-only root, capabilities, limits, cleanup tests |
| Tavily adapter | Implemented server-side | Auth, retry, normalization, timeout, secret-leak tests |
| SQLite backend | Implemented | Schema, WAL, foreign keys, transactions, tenant-scoped API |
| Authentication and sessions | Implemented | scrypt, opaque hashed sessions, expiry, revocation tests |
| Tenant isolation and approvals | Implemented at backend API boundary | Cross-tenant and approval integration tests |
| Durable queue and worker entrypoint | Implemented | SQLite recovery/state transitions and `backend/worker.mjs` |
| Secrets encryption/redaction | Implemented as server helper | AES-256-GCM and redaction tests |
| Security validation | Implemented for current boundaries | SSRF, path traversal, bounds, secret tests |
| Model router | Implemented as server module | Health/capability/cost/latency route tests |
| Persistent memory/RAG | Implemented as tenant/project-scoped module | Isolation and retrieval tests |
| API Client | Implemented for auth/projects/runs/approvals | `src/services/api/client.ts` |
| CI/CD workflows | Implemented | CI, security, Docker smoke, browser smoke workflows |
| Chromium web smoke | Implemented and run locally | Real Chromium rendered `/chat` successfully |

## Items that are deployment operations, not repository gaps

These are intentionally not marked as missing source files. They require external infrastructure, credentials, DNS, or privileged host capabilities:

| Operation | Prepared repository asset | Required field action |
|---|---|---|
| Live Docker/Podman/gVisor/Kata worker | `.github/workflows/docker-smoke.yml`, Docker sandbox | Provision worker host and run live smoke gate |
| Secret manager | `backend/secrets/vault.mjs`, `.env.production.example` | Store `SECRETS_MASTER_KEY` and `TAVILY_API_KEY` in a server vault |
| TLS/domain/reverse proxy | `infra/nginx.conf` | Issue certificate, configure DNS, install Nginx, validate HTTPS |
| Supervised backend/worker | systemd templates in `infra/` | Install and enable services on a persistent host |
| Chromium/CDP production pool | `backend/browser/runner.mjs`, browser workflow | Provision private authenticated browser host/pool |
| Database backup/restore | SQLite schema and service path | Schedule backups, test restore, and choose managed DB at scale |
| Monitoring/alerts | `backend/observability/telemetry.mjs` | Export metrics/logs and configure alerting backend |

## Explicit capability boundary

The server registry reports only configured live tools. It does not claim that catalog entries such as `email.send`, `calendar.schedule`, image generation, or document extraction are live without a real provider adapter and credentials. Such tools fail explicitly and are not counted as production capability.

## Verification basis

- `npm test`: PASS — 80/80 harness, 28/28 execution, 14/14 Phase 1.
- `npm run test:phase2`: PASS — 11/11.
- `npm run test:backend`: PASS — 7/7.
- `npm run test:browser-smoke`: PASS — real Chromium `/chat` smoke.
- `npm run typecheck`: PASS.
- `npm run lint`: PASS.
- `npm run build`: PASS.

The only unexecuted verification is the Docker live-container smoke, because the current Sandbox has no Docker/Podman daemon. The CI workflow is prepared to execute it on a Docker-enabled worker host and must block production release if it fails.
