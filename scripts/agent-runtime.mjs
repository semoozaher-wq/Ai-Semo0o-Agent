#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createExecutionEngine, defaultEvidenceDirectory } from '../execution-core/engine.mjs';
import { provisionTaskWorkspace } from '../execution-core/task-workspace.mjs';

function usage() {
  return `
Semo0o Phase 1 execution runtime

Usage:
  node scripts/agent-runtime.mjs --provision <taskId> --root <baseRoot> [--repo <url>] [--ref <ref>] [--branch <name>] [--allow <capabilities>]
  node scripts/agent-runtime.mjs --workspace <directory> --plan <plan.json> --allow <capabilities>
  node scripts/agent-runtime.mjs --workspace <directory> --git <status|diff|branch> --allow git.read
  node scripts/agent-runtime.mjs --workspace <directory> --checkpoint <message> --allow git.read,git.write
  node scripts/agent-runtime.mjs --workspace <directory> --rollback <revision> --allow git.write

Provisioning (Sandbox + Git lifecycle):
  Creates an isolated workspace per task at <baseRoot>/<taskId>/workspace, clones
  <repo> when given (otherwise initialises a repository), and checks out an
  independent task branch (default semo0o/task/<taskId>). Evidence is written to
  <baseRoot>/<taskId>/evidence, OUTSIDE the Git tree. The protected default
  branch (master/main) is never created or modified, and nothing is pushed.

Capabilities:
  workspace.read, workspace.write, terminal.execute, git.read, git.write, network.access

Plan format:
  {
    "operations": [
      { "type": "patch", "path": "src/file.ts", "expected": "old", "replacement": "new" }
    ],
    "verification": [
      { "command": "npm", "args": ["test"], "timeoutMs": 180000, "memoryLimitMb": 8192 }
    ],
    "maxAttempts": 1
  }

A run is marked "verified" only when every verification command exits 0 without
hitting its timeout or output cap. Failed transactions restore agent-touched files.
`;
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'help') {
      flags.add(key);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return { values, flags };
}

function parseGrants(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  if (flags.has('help')) {
    process.stdout.write(usage());
    return;
  }

  if (values.provision) {
    if (!values.root) throw new Error('--root is required with --provision.');
    const grants = parseGrants(values.allow);
    const handle = await provisionTaskWorkspace({
      taskId: values.provision,
      repo: values.repo,
      ref: values.ref,
      baseRoot: values.root,
      branch: values.branch,
      grants: grants.length > 0 ? grants : undefined,
      evidenceDirectory: values.evidence ? path.resolve(values.evidence) : undefined,
    });
    process.stdout.write(`${JSON.stringify({
      taskId: handle.taskId,
      taskRoot: handle.taskRoot,
      workspacePath: handle.workspacePath,
      evidenceDirectory: handle.evidenceDirectory,
      branch: handle.branch,
      branchCreated: handle.branchCreated,
      clone: handle.clone,
    }, null, 2)}\n`);
    return;
  }

  if (!values.workspace) throw new Error('--workspace is required.');

  const workspacePath = path.resolve(values.workspace);
  const evidenceDirectory = values.evidence
    ? path.resolve(values.evidence)
    : defaultEvidenceDirectory(workspacePath);
  const engine = await createExecutionEngine({
    workspacePath,
    evidenceDirectory,
    grants: parseGrants(values.allow),
  });

  let result;
  if (values.plan) {
    const rawPlan = await fs.readFile(path.resolve(values.plan), 'utf8');
    result = await engine.executeTransaction(JSON.parse(rawPlan));
  } else if (values.git) {
    if (!['status', 'diff', 'branch'].includes(values.git)) throw new Error('Unsupported --git action.');
    result = await engine.git[values.git]();
  } else if (values.checkpoint) {
    result = await engine.git.checkpoint(values.checkpoint);
  } else if (values.rollback) {
    result = await engine.git.rollback(values.rollback);
  } else {
    throw new Error('Provide --plan, --git, --checkpoint, or --rollback.');
  }

  process.stdout.write(`${JSON.stringify({ ...result, evidenceDirectory }, null, 2)}\n`);
  if (result?.state && result.state !== 'verified') process.exitCode = 1;
  if (result?.ok === false) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
