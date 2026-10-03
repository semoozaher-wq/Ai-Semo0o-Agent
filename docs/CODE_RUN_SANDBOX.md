# `code.run` Sandbox Contract

## Status

This repository now contains a **Docker-backed sandbox runner** at `execution-core/sandbox.mjs`.
It is a server-side runtime component. It must not be imported into the Expo client bundle.

The current sandbox runner is intentionally fail-closed:

- It supports JavaScript, TypeScript and Python images.
- Network is always disabled (`--network=none`).
- The root filesystem is read-only.
- Linux capabilities are dropped.
- `no-new-privileges` is enabled.
- The process runs as a non-root UID/GID.
- Memory, CPU, PID, temporary filesystem, timeout and output limits are bounded.
- The temporary workspace is deleted after every run.
- The result contains exit code, signal, output, timeout/truncation state, duration and isolation metadata.

## Agent tool integration

`src/services/agent-engine/code-run.ts` is the explicit bridge between the
Agent tool registry and the server runner. It is deliberately not auto-wired
into the Expo/browser bundle:

- `registerCodeRunTool()` registers the `code.run` tool boundary.
- Without `configureCodeRunAdapter(...)`, execution fails with
  `CODE_RUNNER_NOT_CONFIGURED`; it never returns demo output.
- A backend configures the bridge with
  `createDockerCodeRunAdapter(...)` from `execution-core/code-run-tool.mjs`.
- The adapter returns real stdout, stderr, exitCode, duration, isolation,
  network policy, workspace file list, and evidence directory metadata.

Example server bootstrap (run in a Node backend, not Expo):

```ts
import { createDockerCodeRunAdapter } from './execution-core/code-run-tool.mjs';
import { configureCodeRunAdapter, registerCodeRunTool } from './src/services/agent-engine/code-run';

configureCodeRunAdapter(createDockerCodeRunAdapter({
  getWorkspaceFiles: async () => workspaceFiles,
}));
registerCodeRunTool();
```

The backend must still enforce authentication, workspace ownership, approval
for the dangerous capability, concurrency quotas, and evidence persistence.

## Controlled Node VM runner

`runJavaScriptInVm()` is also available for low-risk server-side snippets and
deterministic tests. It provides:

- A fresh `vm.createContext()` for every call.
- A 3-second default timeout with a 5-second hard maximum.
- Captured `console.log/info/warn/error` records.
- Promise/async result handling.
- Bounded console output.
- Structured error results instead of uncaught runtime failures.
- Bounded `setTimeout`/`clearTimeout` handles that are cleaned up after the run.

Node's `vm` module is **not a hostile-code security boundary**. Do not use this
runner for user-supplied or agent-generated code that must be treated as
untrusted. Use the Docker/microVM runner for that workload.

## Usage

```js
import { DockerSandboxRunner } from './execution-core/sandbox.mjs';

const runner = new DockerSandboxRunner({
  onEvidence: async (evidence) => {
    // Persist this on the server-side run/evidence store.
  },
});

const result = await runner.run({
  language: 'javascript',
  source: 'console.log("hello")',
  timeoutMs: 30_000,
  maxOutputBytes: 256_000,
});

if (!result.ok) {
  // Never convert this result to a successful task.
  throw new Error(result.stderr || 'Sandbox execution failed');
}
```

## Deployment requirements

A production backend must provide:

1. Docker, Podman, gVisor, Kata or a microVM runtime.
2. Pinned and scanned language images.
3. A non-root container runtime configuration.
4. No Docker socket exposed to agent code.
5. Server-side authentication and workspace authorization.
6. Evidence persistence outside the ephemeral container.
7. Queue/concurrency controls and per-tenant quotas.
8. Network egress policy if a future capability explicitly allows network access.

The current development sandbox does not have Docker or Podman installed, so tests validate the runner contract and generated isolation arguments with an injected process adapter. A live container smoke test must run in CI or on the backend host that provides the container runtime.

## Verification rule

`exitCode === 0` is not sufficient to mark a task complete. The orchestrator must run explicit verification checks and require successful evidence before returning `completed`.
