# PHASE 2 — Real Coding Agent / `code.run`

## Status

**PARTIALLY IMPLEMENTED, INTEGRATED AT THE SERVER-RUNNER BOUNDARY, AND REGRESSION-VERIFIED.**

The repository already contained a real Docker sandbox and a real Node execution engine. The missing production gap was the connection from the Agent Tool Registry to that server-side execution boundary. This phase adds that connection without importing Node process APIs into the Expo/browser bundle.

## Implemented

### 1. Strict Agent Registry bridge

`src/services/agent-engine/code-run.ts` adds:

- `configureCodeRunAdapter(adapter)`.
- `registerCodeRunTool()` and `unregisterCodeRunTool()`.
- Strict language/source normalization.
- Explicit bounded timeout and output controls.
- Fail-closed behavior with `CODE_RUNNER_NOT_CONFIGURED` when no server runner is configured.
- `simulated: false` and structured Evidence output.

The client cannot execute a process. Therefore the bridge is not auto-wired into Expo. A server runtime must configure it deliberately.

### 2. Real Docker adapter

`execution-core/code-run-tool.mjs` adds `createDockerCodeRunAdapter()`:

- Uses the existing `DockerSandboxRunner`.
- Forwards Workspace files into the isolated run.
- Preserves stdout, stderr, exitCode, timeout/truncation, duration, isolation, network policy, and evidence directory.
- Forces `network: none` through the existing sandbox policy.

### 3. Tool schema

`code.run` now exposes bounded `timeoutMs` and `maxOutputBytes` controls. The language enum remains restricted to JavaScript and Python in the catalog; TypeScript is supported by the server adapter contract and can be enabled after the catalog enum is expanded intentionally.

### 4. Regression coverage

Added tests prove:

- No configured server runner cannot produce a fake result.
- Configured `code.run` forwards source and returns evidence through the registry.
- Docker adapter forwards Workspace files and preserves isolation metadata.
- Existing sandbox policy, timeout, output cap, and cleanup tests remain green.

## Files added or changed

- `src/services/agent-engine/code-run.ts`
- `execution-core/code-run-tool.mjs`
- `src/data/tools.ts`
- `test/code-run-integration.test.ts`
- `test/sandbox-runner.test.mjs`
- `package.json`
- `docs/CODE_RUN_SANDBOX.md`
- `docs/PRODUCTION_GAP_MATRIX.md`
- `docs/PHASE2_CODE_RUN_REPORT.md`

## Verification results

| Gate | Result |
|---|---:|
| `npm run test:phase1` | PASS — 14/14 |
| `npm run test:execution` | PASS — 28/28 |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |

## Live-runtime limitation

The active Sandbox environment does not have Docker or Podman installed. Existing tests use an injected process adapter to verify Docker invocation, isolation flags, output limits, cleanup, and evidence behavior. A real container smoke test must run on the authenticated backend/worker host that provides Docker, Podman, gVisor, Kata, or a microVM runtime.

This limitation is intentional and is not represented as a successful live container run.

## Remaining work before Phase 2 is fully production-running

1. Deploy the Node adapter inside an authenticated backend worker.
2. Configure `configureCodeRunAdapter(createDockerCodeRunAdapter(...))` in that backend only.
3. Bind `getWorkspaceFiles` to an authorized tenant/workspace snapshot.
4. Persist Evidence outside the temporary sandbox directory.
5. Add a live Docker smoke test in CI/backend infrastructure.
6. Connect code edits and verification commands to the broader `AgentExecutionEngine` transaction path for automatic patch/retry/rollback.
7. Expand the tool schema intentionally if TypeScript and explicit workspace file inputs should be model-selectable.
