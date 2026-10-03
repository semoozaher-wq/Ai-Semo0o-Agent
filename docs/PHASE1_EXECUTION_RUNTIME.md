# Phase 1 — Real Execution Runtime

This repository now includes a **Node-hosted execution core** at `execution-core/engine.mjs` and a CLI entry point at `scripts/agent-runtime.mjs`.

> The Expo client remains a client. Browser and mobile JavaScript must not access a terminal or arbitrary filesystem directly. Deploy the runtime behind an authenticated server-side adapter, or run the CLI on an approved machine that holds the checked-out workspace.

## Guarantees implemented

| Requirement | Implementation |
| --- | --- |
| Real sandbox / terminal | `TerminalSandbox` starts allow-listed programs with `spawn(..., { shell: false })`; it never interpolates a shell command. |
| Timeout and resource controls | Per-command wall-clock timeout, bounded combined output, and Linux `prlimit` CPU/address-space limits are recorded with each result. |
| Real file engine | `RealWorkspace` reads, atomically writes, patches, and deletes actual files under one selected root. Absolute paths, `..` traversal, and symlink traversal are rejected. |
| Safe patch | A patch requires the exact expected pre-image; a changed file produces `PATCH_CONFLICT` rather than being overwritten. |
| Real Git engine | `status`, `diff`, `branch`, `checkpoint` (commit), and `rollback` are executed through the bounded terminal. Rollback never calls `git clean`, so untracked user files are not implicitly deleted. |
| Verification evidence | A transaction can become `verified` only when every declared verification command exits 0 without timeout or output truncation. JSON results, command logs, and Git diff are written to an evidence directory. |
| Self-healing / replan | A failed transaction restores only files touched by its operations. An optional bounded `replan` callback receives a structured failure analysis and may supply a replacement plan. |
| Permission gateway | Default-deny `PermissionGateway` checks `workspace.read`, `workspace.write`, `terminal.execute`, `git.read`, `git.write`, and `network.access` at every protected operation. |

## Running a transaction

Create a plan such as `plan.json`:

```json
{
  "operations": [
    {
      "type": "patch",
      "path": "src/example.ts",
      "expected": "export const enabled = false;\n",
      "replacement": "export const enabled = true;\n"
    }
  ],
  "verification": [
    {
      "command": "npm",
      "args": ["test"],
      "timeoutMs": 180000,
      "memoryLimitMb": 8192,
      "cpuLimitSeconds": 180
    },
    {
      "command": "npm",
      "args": ["run", "build"],
      "timeoutMs": 300000,
      "memoryLimitMb": 8192,
      "cpuLimitSeconds": 300
    }
  ],
  "maxAttempts": 1
}
```

Run it with explicit grants:

```bash
node scripts/agent-runtime.mjs \
  --workspace /absolute/path/to/project \
  --plan ./plan.json \
  --allow workspace.read,workspace.write,terminal.execute,git.read,git.write
```

If a verification command needs package download or another network operation, add both `"needsNetwork": true` to that command and `network.access` to `--allow`.

## Git actions

```bash
node scripts/agent-runtime.mjs --workspace /path/to/project --git status --allow git.read
node scripts/agent-runtime.mjs --workspace /path/to/project --checkpoint "before refactor" --allow git.read,git.write
node scripts/agent-runtime.mjs --workspace /path/to/project --rollback <commit-sha> --allow git.write
```

## Evidence and failure states

The CLI prints the evidence directory. By default it is `.semo0o-evidence/<run-id>` under the selected workspace and is ignored by Git. A failed change returns `failed_rolled_back`; it is **not** reported as complete. The saved `result.json`, `verification.json`, `manifest.json`, and `git.diff` preserve the actual outcome and the rollback details.

## Test coverage

`npm test` runs the existing TypeScript harness and native Node tests that prove permission denial, workspace boundary protection, terminal limits, Git checkpoint/rollback, failed-verification rollback, evidence capture, and a one-step replan.
