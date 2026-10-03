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
