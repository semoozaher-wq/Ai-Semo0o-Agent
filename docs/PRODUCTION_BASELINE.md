# Ai-Semo0o-Agent — Production Baseline

**Task:** 0.1 — Repository Baseline  
**Repository:** `semoozaher-wq/Ai-Semo0o-Agent`  
**Review date:** 2026-10-03  
**Scope:** architecture, entry points, runtime paths, tests, and production gaps only.

> هذه الوثيقة تصف التنفيذ الموجود فعليًا، ولا تعتبر وجود ملف أو واجهة دليلًا على اكتمال الميزة.

## 1. Repository structure

| Area | Actual location | Role |
|---|---|---|
| UI routes | `app/` | Expo Router routes and tab navigation |
| UI screens | `src/screens/` | Dashboard, Store, Chat, Agents, Files, Analytics, Settings, Workspace, Anatomy |
| Components | `src/components/` | UI primitives, composites, charts, BodyMap |
| Domain types | `src/types/` | Task, tool, model, chat, file, workspace, anatomy types |
| State | `src/store/` | Zustand stores and local persistence |
| AI runtime | `src/services/ai/` | Provider abstraction, HTTP providers, tool loop, schema validation |
| Agent services | `src/services/agent-engine/` | Rule template executor, LLM planner, orchestrator, memory, tool registry |
| Workspace services | `src/services/workspace/` | Virtual workspace, GitHub, ZIP, file operations, tool adapters |
| Code/data services | `src/services/code-analysis/`, `src/services/data-engine/` | Static analysis and in-memory dataset/file analysis |
| Node execution runtime | `execution-core/` | Permissioned filesystem, terminal, Git, evidence and verification runtime |
| Phase 2 Node core | `phase2-core/` | Task graph, project intelligence, RAG, persistent memory, platform/package/browser cores |
| Tests | `test/` | TypeScript harness, Node runtime tests, Phase 1 and Phase 2 tests |
| Static web output | `dist/` | Expo web export output; generated artifact, not the runtime source |
| Legacy | `legacy/` | Preserved BodyMap implementation for reference/compatibility |

## 2. Entry points

### Client entry points

- `app/_layout.tsx`: root Expo Router layout, providers and app bootstrap.
- `app/(tabs)/_layout.tsx`: tab navigation.
- `app/(tabs)/*.tsx`: dashboard, store, chat, agents and files routes.
- `app/analytics.tsx`, `app/settings.tsx`, `app/anatomy.tsx`, `app/workspace.tsx`: standalone routes.
- `src/screens/*.tsx`: screen implementations rendered by the routes.

### Runtime entry points

- `src/services/ai/runtime.ts`: provider registry and `AIService`.
- `src/services/ai/providers/*.ts`: live HTTP adapters for OpenAI, Anthropic and Google Gemini.
- `src/services/agent-engine/llm-planner.ts`: strict JSON plan generation and validation.
- `src/services/agent-engine/orchestrator.ts`: plan execution, permission checks, tool calls and status decisions.
- `src/services/agent-engine/tools.ts`: schema validation and explicit tool registration.
- `execution-core/engine.mjs`: Node-hosted real workspace/terminal/Git execution.
- `phase2-core/platform.mjs`: Phase 2 graph, intelligence, RAG, memory and platform primitives.

## 3. Actual runtime paths

### Chat path — current baseline

`ChatScreen` → `useChatStore` → AI service/provider path.

The screen-level chat flow is separate from the Phase 1 `AgentOrchestrator` flow. The LLM planner/orchestrator is not currently the universal path for every Chat request. This is a production gap to be handled by a later dedicated wiring task.

### Agents path — current baseline

`AgentsScreen` → `agentExecutor` in `src/services/agent-engine/executor.ts`.

The legacy executor still creates a deterministic template plan with `createPlan()` when a task has no plan. It invokes tools through `runTool()`, but it is not yet unified with `AgentOrchestrator` and `LLMPlanner`.

### LLM orchestrator path — current baseline

Caller supplies:

`OrchestratorInput` → `LLMPlanner.plan()` → strict plan normalization → `runTool()` → permission gate → status/evidence decisions.

The planner rejects invalid JSON, unknown tools, invalid dependencies and cyclic dependencies before execution. A provider fallback is supported inside `LLMPlanner`.

### Workspace tool path

`useWorkspaceStore` imports `src/services/workspace/tools.ts`, which registers real GitHub/ZIP/workspace adapters into the shared tool registry. Unregistered tools fail explicitly; they do not produce fabricated success.

### Node execution path

`execution-core/engine.mjs` is a separate Node runtime. It provides permission-gated file access, atomic writes, path/symlink protections, command allow-listing, resource limits, Git operations and evidence manifests. The mobile/web client must call it through a backend or local runner; it cannot safely execute Node commands in the browser.

### Browser path

`phase2-core/browser-agent.mjs` exposes a CDP-based browser client and verification API. Existing tests cover the contract and load-event behavior. A live Chrome/Chromium E2E integration is not yet present in the repository baseline.

## 4. Component status by subsystem

| Subsystem | Actual baseline | Production assessment |
|---|---|---|
| UI | Extensive Expo/RN/ web UI and routes | Present, but UI presence does not prove backend/runtime integration |
| AI Runtime | Real HTTP provider adapters for OpenAI, Anthropic, Gemini | Real when configured; no fake provider fallback remains after the current hardening change |
| Planner | Strict `LLMPlanner`; deterministic `createPlan` also exists | LLM planner is real; legacy executor still has rule-template fallback |
| Orchestrator | `AgentOrchestrator` with permissions and status handling | Present, but not the universal UI path |
| Tools | Registry with strict schema validation; workspace adapters registered | Workspace tools real; many catalog tools intentionally fail when no adapter is configured |
| Execution Runtime | Node permissioned filesystem/terminal/Git runtime | Strong core; no permanent HTTP backend boundary |
| Browser | CDP client and contract tests | No live Chrome E2E matrix yet |
| Memory | Agent working memory plus Phase 2 persistent memory | Present; boundaries and multi-tenant isolation are not production-complete |
| RAG | Local deterministic embedding, remote embedding adapter, vector store, reranking | Core exists; production embedding selection and isolation need completion |
| Storage | Local KV/persistence and JSON Phase 2 stores | Suitable for local/core tests; not a production database |
| Backend | No persistent HTTP server/API boundary in the repository | Missing |
| Auth | No signup/login/session/authorization backend | Missing |
| Security | Default-deny permissions, path/symlink checks, command allow-list, resource limits | Good runtime foundation; server isolation and tenancy remain missing |
| Tests | Harness, runtime, Phase 1, Phase 2 tests | Broad unit/contract coverage; integration/browser E2E/CI matrix incomplete |

## 5. Test and build commands

Defined in `package.json`:

```bash
npm test
npm run test:phase2
npm run typecheck
npm run lint
npm run build
npm run doctor
```

The repository also contains:

```bash
npm run export:web
npm run validate:pain-map
npm run generate:anatomy
```

Baseline verification performed before/while creating this report:

- `npm test`: passed after dependency installation.
- `npm run test:phase2`: passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed and exported 17 static routes.
- `npm run doctor`: not executed in this task; reserved for TASK 0.2.

## 6. Production gaps identified

1. **UI/runtime unification:** Chat and Agents do not yet share one universal orchestrator path.
2. **Tool coverage:** only explicitly registered integrations execute; catalog tools still need real adapters for web search, code execution, data/files/media, translation, calendar and email.
3. **Execution boundary:** `execution-core` is not exposed through an authenticated, persistent backend API.
4. **Code execution wiring:** the catalog `code.run` tool is not yet connected to `execution-core`.
5. **Verification evidence:** Node execution has evidence primitives, but the client orchestrator does not yet carry one unified evidence model for every tool.
6. **Browser verification:** no real Chrome/Chromium E2E suite with screenshots, console errors and network-failure capture.
7. **Storage:** JSON/local persistence is not a transactional, concurrent production database.
8. **Authentication/authorization:** no user/session/tenant boundary or server-side authorization model.
9. **Secrets:** provider keys are configured from client settings; production secrets must move to server-side secret management.
10. **Sandboxing:** untrusted code requires container/VM isolation beyond the current Node process controls.
11. **Observability:** run evidence, usage, latency and audit data are not unified across all paths.
12. **CI/CD and security matrix:** no verified repository CI workflow covering all required checks, integration, security and browser E2E tests.
13. **Documentation drift:** README and planning documents describe capabilities broader than the currently wired production path; they require later reconciliation.

## 7. Baseline conclusion

The repository is a substantial Expo/TypeScript client and Node execution core with real provider abstractions, strict planner validation, workspace integrations and meaningful runtime tests. It is **not yet a complete multi-tenant production AI platform**. The highest-risk architectural gaps are the missing client/server boundary, missing auth/tenancy, incomplete tool adapters, and the split between screen-specific execution and the real orchestrator.

No Phase 1–22 implementation work is claimed by this baseline task.
