# PHASE 1 — Unified Agent Runtime + Chat/Agents Integration

## STATUS

**IMPLEMENTED AND REGRESSION-VERIFIED.** This phase is not being labeled fully production-ready because the master task explicitly reserves the authenticated backend, durable workers, real browser E2E, and production secrets/database work for later phases.

**Audit baseline SHA:** `761a045` (`HEAD` at audit start). No new Git commit was created in the sandbox; the changes listed below are in the working tree and are delivered in the ZIP artifact.

## IMPLEMENTED

The existing modern runtime is now the production path for the Agents store. Complex Chat goals are routed into the same path instead of receiving an independent direct-LM answer. Ordinary questions remain on the direct streaming Chat path.

The connected execution path is:

```text
User Goal → Chat/Agents → LLMPlanner → AgentOrchestrator → Tool Registry
→ Real Tool Adapter → Observe → Verification → Evidence → Self-Healing
→ Final Result → Task/Chat UI
```

The Agents UI receives real orchestrator events for planning, step start, tool completion, verification, permission requests, retries, and final state. The task model now represents `blocked`, `completed_with_warnings`, and `unverified` separately, rather than converting blocked work into failed work.

A real Approval Surface was added for dangerous tools. It displays the tool, requested capability, reason, affected paths, reversibility, risk, and explicit **Approve / Reject** controls. Rejecting the request returns `BLOCKED`; approval resumes the same orchestrator execution.

Self-healing remains bounded to three attempts. A run that succeeds only after repair/retry is reported as `COMPLETED_WITH_WARNINGS` and records a `SELF_HEALED` warning instead of silently appearing as an unqualified success.

## CHANGED FILES

- `docs/PRODUCTION_GAP_MATRIX.md`
- `docs/PHASE1_UNIFIED_RUNTIME_REPORT.md`
- `src/services/agent-engine/orchestrator.ts`
- `src/store/useAgentsStore.ts`
- `src/store/useChatStore.ts`
- `src/hooks/useBootstrap.ts`
- `src/types/task.ts`
- `src/types/chat.ts`
- `src/screens/Agents.tsx`
- `src/screens/Analytics.tsx`
- `test/phase1-orchestrator.test.ts`

## REMOVED LEGACY PATHS

The Agents store no longer calls the legacy `agentExecutor` in its production UI path. The legacy executor files remain in the repository because they are still part of the existing codebase and were not deleted without a complete usage/removal migration. The new store uses `agentOrchestrator` directly.

## REAL INTEGRATIONS

- Chat complex-goal routing uses the real Zustand stores and `AgentOrchestrator`.
- Agents UI uses the real orchestrator event callback and result/evidence collections.
- Provider configuration is loaded from hydrated settings at bootstrap.
- Dangerous-tool permission decisions are now supplied by a user-facing approval resolver.
- Verification rejects missing, simulated, or contradictory evidence.
- No fake response or fabricated success path was added.

## SIMULATED FEATURES

No simulated production feature was added. Deterministic providers are used only in repeatable tests. The local task store is still a client-side persistence layer, not a production backend. Real Chromium E2E is not claimed in this phase.

## TESTS

| Gate | Result |
|---|---|
| `npm test` | PASS — harness 80/80, execution 27/27, Phase 1 12/12 |
| `npm run test:phase2` | PASS — 11/11 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS — Expo web export completed |

Phase 1 regression coverage includes successful verification, false success rejection, event emission, permission denial, self-healing, completed-with-warnings after repair, retry limits, missing evidence, and simulated-output rejection.

## SECURITY

Dangerous tools remain default-deny until the user makes an explicit decision. The approval UI shows affected paths and reversibility before execution. Tool arguments continue to pass through strict validation. Unregistered tools fail explicitly. No secrets are included in the artifact.

## EVIDENCE

The existing evidence model is preserved and connected to the orchestrator with `runId`, `taskId`, `stepId`, tool-result output, duration, simulation state, and timestamps. The UI now exposes verification state and retry count on each task step. Persistent server-side evidence storage remains a later backend phase.

## REMAINING GAPS

- Phase 2: connect `code.run` from the Agent registry to the tested execution-core Docker sandbox and prove real coding-agent end-to-end execution.
- Phase 3: authenticated backend API, production database, migrations, authorization, and tenant isolation.
- Phase 4: durable queue/worker runs that survive app/browser disconnects.
- Phase 5: real Chromium BrowserAgent integration and browser E2E evidence.
- Phase 6: production Memory/RAG isolation, retention, deletion, and vector storage.
- Phase 7: task-aware model router and remaining live tool adapters.
- Phase 8: signed plugins, backend secret storage, rotation, and scoped access.
- Phase 9: correlated observability, security regression matrix, CI/CD enforcement.

The complete audit matrix is in `docs/PRODUCTION_GAP_MATRIX.md`.
