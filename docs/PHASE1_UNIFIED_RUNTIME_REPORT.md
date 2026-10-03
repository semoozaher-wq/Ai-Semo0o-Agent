# PHASE 1 — Unified Agent Runtime + Chat/Agents Integration

## IMPLEMENTED

- Connected the **Agents store** to the existing modern `AgentOrchestrator` instead of the legacy `AgentExecutor` path.
- Added live orchestrator event delivery to the UI store for planning, step start, tool execution, verification, and failure events.
- Added **Chat goal classification**:
  - Ordinary questions continue through the direct streaming Chat path.
  - Complex coding/project/execution goals create an Agent task and run through Planner → Orchestrator → Tools → Verification.
- Added an `agentTaskId` reference to assistant messages for traceability.
- Configured live AI providers from hydrated settings during application bootstrap.
- Extended task status and step metadata with:
  - `unverified`
  - verification status
  - evidence IDs
  - retry count
- Updated Agents UI to show real task steps, verification badges, retry counts, and live event logs.
- Updated Analytics UI to include `unverified` task status.
- Added regression coverage for live orchestrator event emission.

## FILES CHANGED

- `src/services/agent-engine/orchestrator.ts`
- `src/store/useAgentsStore.ts`
- `src/store/useChatStore.ts`
- `src/hooks/useBootstrap.ts`
- `src/types/task.ts`
- `src/types/chat.ts`
- `src/screens/Agents.tsx`
- `src/screens/Analytics.tsx`
- `test/phase1-orchestrator.test.ts`

## REAL FEATURES

- Chat-to-Agent task routing is implemented in the real Zustand store path.
- Agents UI is backed by the modern orchestrator result and event callback.
- The verification gate and evidence collection remain the existing production code paths.
- Provider absence fails closed with an explicit error; no fake response is generated.
- Dangerous tools remain permission-controlled and are denied by default from the current UI path.

## SIMULATED FEATURES

- No simulated production success was added.
- The Phase 1 unit tests use a deterministic provider adapter only for repeatable CI; it is not used as a production fallback.
- Ordinary Chat remains direct LLM streaming by design; it is not an Agent run unless the goal classifier identifies a complex execution request.

## WIRED FEATURES

```text
Ordinary question → direct AI stream → Chat message

Complex goal → useChatStore
            → useAgentsStore.createTask
            → AgentOrchestrator
            → LLMPlanner
            → Tool Registry
            → Verification/Evidence
            → Task result + Chat message reference
```

Agents screen:

```text
Goal → AgentOrchestrator → onEvent → Zustand task/log state → Live Timeline
```

## TESTS

| Gate | Result |
|---|---|
| `npm test` | PASS — harness 80/80, execution 27/27, Phase 1 12/12 |
| `npm run test:phase2` | PASS — 11/11 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS — Expo web export completed |

The new Phase 1 regression proves the orchestrator emits real planning, step, tool, and verification events.

## E2E

- Expo web production export passed and generated all 17 static routes.
- Real Chromium browser E2E is **not part of Phase 1** and remains scheduled for Phase 5.
- A live external-provider E2E run requires configured provider credentials and is intentionally not faked in CI.

## SECURITY

- Unregistered tools continue to fail explicitly.
- Dangerous tools remain deny-by-default unless a permission callback grants access.
- Provider keys are only converted into server-provider configuration at runtime; a backend secret store is still required in Phase 3/8.
- No secrets are included in the ZIP artifact.

## KNOWN LIMITATIONS

- The UI currently supplies a deny-by-default permission callback for dangerous tools; a user approval surface is still required before enabling destructive tools from Chat/Agents.
- Agent runs are persisted locally through the existing store until the Backend/Database phase.
- The event callback currently covers live execution events; the final result is committed to the task store after the run returns.
- `TaskStatus` has no separate `blocked` value yet; blocked runs are represented as failed in the UI while the orchestrator result retains the true blocked status.

## REMAINING GAPS

- PHASE 2: complete live coding-agent tool wiring and prove `code.run` reaches the real execution-core sandbox from the production Agent path.
- PHASE 3: backend database, migrations, transactions, authentication, authorization, and multi-tenancy.
- PHASE 4: durable background workers and resumable runs.
- PHASE 5: real BrowserAgent integration and Chromium E2E.
- PHASE 6+: production memory/RAG, model router, plugins, secrets, observability, security audit, and CI/CD hardening.

## STATUS

**PHASE 1 IMPLEMENTED AND VERIFIED.** The project is not yet claimed to be fully production-ready because the remaining phases are not complete.
