# Ai-Semo0o-Agent — Production Gap Matrix

**Audit basis:** repository HEAD `761a045` plus the current working-tree changes from the completed sandbox, Tavily, Verification, and Phase 1 integration tasks. The matrix distinguishes file presence from an actually connected and tested runtime path.

| Requirement | Existing | Connected | Real | Tested | Missing |
|---|---|---:|---:|---:|---|
| Unified Planner → Orchestrator → Tools → Verification path | `LLMPlanner`, `AgentOrchestrator`, tool registry, verification | Partial / Agents connected; Chat routes complex goals | Yes for orchestrator path | Yes: Phase 1 12 tests | Approval surface, full live-provider E2E |
| Ordinary Chat path | `useChatStore` + `aiService.stream` | Yes | Yes when provider configured | Existing harness coverage | Provider/API errors surfaced only in Chat message |
| Complex Chat → Agent routing | `requiresAgentExecution()` + Agents store | Yes | Yes, uses `AgentOrchestrator` | No dedicated store/UI integration test | Classifier precision and task resume |
| Agents UI timeline | `useAgentsStore` event callback + `StepTimeline` | Yes | Yes for emitted orchestrator events | Orchestrator event regression only | Browser/UI E2E |
| Verification Gate | `verification.ts` | Yes from orchestrator | Yes | Yes: VERIFIED/FAILED/UNVERIFIED cases | Official CANCELLED/COMPLETED_WITH_WARNINGS task statuses |
| Evidence model | `Evidence` with run/task/step IDs and tool result fields | Yes from orchestrator | Yes for tool-result evidence | Yes in Phase 1 and execution-core tests | Persistent backend evidence store |
| Self-healing | Orchestrator retry/selfHeal callback | Yes in orchestrator tests | Yes, bounded to 3 attempts | Yes: retry success and retry limit | Repair through safe patch/workspace in client path |
| Dangerous-tool permission gate | Orchestrator `requestPermission`, execution-core permission gateway | Partial; Agents UI currently deny-by-default | Yes in core | Yes: permission denial tests | User Approval UI and approval persistence |
| Task statuses | `TaskStatus` plus orchestrator statuses | Partial | `blocked` exists in orchestrator but UI mapping is incomplete | Partial | Add `blocked`, `completed_with_warnings`, `pending` consistently to UI/task model |
| `code.run` | Catalog, configurable registry bridge, Docker/VM sandbox modules | Yes at the server-runner boundary; not auto-wired into Expo client | Docker adapter and sandbox are real; live container requires backend runtime | 14 Phase 1 tests + 28 execution tests pass; no live Docker smoke test in Sandbox | Deploy Node backend with Docker/Podman, configure adapter, persist evidence, run live container smoke/E2E |
| `code.analyze` | Analyzer service exists | Not registered in agent tool registry | Service real, Agent path absent | Existing analyzer coverage partial | Register adapter with workspace/evidence contract |
| Workspace tools | `workspace/tools.ts` | Imported by `useWorkspaceStore` | Real in local workspace | Existing Phase 2 tests | Authenticated backend workspace boundary |
| `files.read/write/scan` | Catalog entries | Not registered as matching Agent tools | No unified live adapter | No direct Agent-path tests | Register or mark unavailable |
| `web.search` | Tavily server adapter | Not registered in `src/services/agent-engine/tools.ts` | Adapter real, client tool path absent | Tavily adapter tests pass | Backend-only registration and provider configuration |
| `web.scrape` | Catalog only | No implementation | No | No | Implement SSRF-safe server adapter or report unavailable |
| Data/media/document tools | Catalog entries and some services | Not registered in Agent runtime | Mixed | No full tool-path tests | Live adapters or explicit UNAVAILABLE states |
| GitHub/ZIP tools | Workspace registrations | Yes through workspace side-effect import | Real local/browser workspace implementation | Existing Phase 2 tests | Private repo auth, rate-limit and backend isolation |
| Execution sandbox | `execution-core/sandbox.mjs` Docker + bounded VM | Not reached by `code.run` Agent tool | Docker policy real; VM not hostile-code boundary | Sandbox tests pass | Docker availability gate and production service boundary |
| Workspace security | JS workspace service and execution-core file checks | Partial | Local boundary real | Traversal/symlink/atomic-write tests pass | Multi-tenant backend boundary |
| Rollback | execution-core transaction/Git rollback | Not connected to current UI Agent run | Real execution-core rollback | Rollback tests pass | Agent repair path integration |
| Persistent storage | Zustand + localStorage/in-memory KV; JSON platform cores; new SQLite backend | Backend API connected for projects/tasks/runs/evidence | SQLite backend real; client migration incomplete | Backend DB/API tests pass | Move client reads/writes to authenticated API; backups/managed DB |
| Backend API | `backend/server.mjs` plus legacy workspace CLI | Authenticated API connected for auth/projects/runs/approvals | Real Node HTTP + SQLite API | 7 backend integration/security tests pass | Client API client, TLS/rate-limit deployment, external worker hosting |
| Database entities | `backend/db/schema.sql` and SQLite repositories via API | Backend connected | Real SQLite tables, foreign keys, indexes, transactions | Backend tests pass | Production DB service/backup/replication and remaining API repositories |
| Authentication | Client settings plus `backend/auth/security.mjs` | Backend register/login/logout connected | scrypt + opaque hashed sessions real | Auth integration tests pass | Client auth integration, CSRF strategy, refresh rotation, TLS deployment |
| Authorization/multi-tenancy | Permission concepts only | No tenant-aware API | No | No | Ownership checks and cross-tenant security tests |
| Durable background runs | `backend/queue/queue.mjs` | Backend run API connected | SQLite-backed queue/recovery/state transitions real | Queue integration tests pass | Supervised multi-process worker, leases/heartbeats, external queue at scale |
| Browser Agent | CDP `BrowserAgent` core | Not registered in Agent tool runtime | Adapter real when CDP exists | CDP contract tests only | Planner/tool wiring and real Chromium E2E |
| Memory/RAG | `phase2-core` JSON/vector core plus `backend/memory/store.mjs` | Backend memory store connected | Tenant/project-scoped SQLite documents + embeddings real | Memory isolation test passes | Client API integration, remote embeddings/vector DB, retention jobs |
| Model router | Provider catalog plus `backend/models/router.mjs` | Backend router module connected | Capability/health/cost/latency selection real | Router test passes | Connect orchestrator/provider calls and persist health/cost |
| Plugins/store | `AgentPackageStore` and UI store | Partial | Local package lifecycle real | Install/dependency/rollback tests | Manifest signature, trust, security scan, backend registry |
| Secrets | Client settings remain legacy; `backend/secrets/vault.mjs` added | Backend vault helper available | AES-256-GCM encryption/redaction real | Secret utility test passes | Remove client raw-key storage, secret manager/rotation deployment |
| Observability | Logs, usage, task IDs/events plus `backend/observability/telemetry.mjs` | Backend telemetry module available | Structured logs/spans/metrics real | Telemetry test passes | Attach all API/worker/tool spans and export to monitoring backend |
| Evidence UI | Timeline displays logs and verification badges | Partial | Local task result only | No UI E2E | stdout/stderr/exit code/diff/screenshot drill-down |
| Security audit | Execution-core security controls | Partial | Several controls real | Regression tests for core path | SSRF, auth, IDOR, tenant isolation, prompt/tool injection, secret leakage |
| CI/CD | npm scripts | Local only | Build/test scripts real | All local gates pass | CI workflow with security audit and browser E2E |
| Real Browser E2E | No Playwright/Chromium test suite | No | No | No | Add Chromium launch, DOM actions, screenshots, console/network evidence |

## Phase decision

**Phase 1 is partially implemented, not fully closed:** the unified Chat/Agents runtime, verification/evidence flow, self-healing loop, and live timeline are connected and tested. The remaining Phase 1 blockers are the user Approval UI and complete task status model (`BLOCKED`, `COMPLETED_WITH_WARNINGS`, `CANCELLED`) across the UI and stores.

**Phase 2 is partially implemented:** `code.run` now has a strict Agent Registry bridge and a Node-side Docker adapter that forwards workspace files and returns real sandbox evidence. A live container smoke test and authenticated backend deployment are still required before calling the capability production-running.

**Phases 3–10 remain open:** backend/database/auth/multi-tenancy, durable workers, browser E2E, production memory/RAG, model routing/live tools, plugins/secrets, observability/security/CI, and final audit.

## Evidence basis

- `npm test`: passed after the previous Phase 1 integration.
- `npm run test:phase2`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- Existing tests prove sandbox policy, Tavily adapter behavior, execution-core rollback, task graph behavior, browser adapter contracts, and orchestrator verification/self-healing. They do not prove a production backend, real authentication, real Chromium E2E, or end-to-end `code.run` wiring.
