import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Capability, createExecutionEngine, isDefaultBranch } from './engine.mjs';

/**
 * Per-task isolated workspace provisioning for the Phase 1 sandbox + Git
 * lifecycle. This module adds no new sandboxing of its own: it composes the
 * existing execution runtime (`RealGit` + `createExecutionEngine`) so a single
 * task gets its own checkout on its own branch, with evidence kept OUTSIDE the
 * Git tree.
 *
 * Layout for a task:
 *   <baseRoot>/<taskId>/workspace   <- the Git checkout (isolated per task)
 *   <baseRoot>/<taskId>/evidence    <- run evidence (never committed)
 */

export const DEFAULT_TASK_BRANCH_PREFIX = 'semo0o/task/';

// Capabilities the Git lifecycle needs. Network is added only for remote clones.
const TASK_GRANTS = Object.freeze([
  Capability.FILE_READ,
  Capability.FILE_WRITE,
  Capability.TERMINAL_EXECUTE,
  Capability.GIT_READ,
  Capability.GIT_WRITE,
]);

function safeTaskId(taskId) {
  if (typeof taskId !== 'string' || taskId.trim().length === 0 || taskId.length > 128) {
    throw new Error('INVALID_TASK_ID');
  }
  const value = taskId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error('INVALID_TASK_ID');
  return value;
}

function isRemoteRepo(repo) {
  return /^(https?:|git@|ssh:|git:\/\/)/i.test(String(repo ?? '').trim());
}

/** Deterministic, filesystem-safe branch name for a task. */
export function taskBranchName(taskId, prefix = DEFAULT_TASK_BRANCH_PREFIX) {
  return `${prefix}${safeTaskId(taskId)}`;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Provision an isolated workspace for a single task.
 *
 * - `repo` (optional): a Git URL or local path to clone. When omitted, an empty
 *   repository is initialised so the task still gets a real branch.
 * - `branch` (optional): defaults to `semo0o/task/<taskId>`. The protected
 *   default branch (master/main) is always refused.
 * - `allowExisting`: reuse an already-provisioned checkout instead of failing.
 *
 * Returns a handle: `{ taskId, taskRoot, workspacePath, evidenceDirectory,
 * branch, branchCreated, clone, engine }`.
 */
export async function provisionTaskWorkspace({
  taskId,
  repo,
  ref,
  baseRoot,
  branch,
  grants,
  limits,
  evidenceDirectory,
  allowExisting = false,
} = {}) {
  const id = safeTaskId(taskId);
  if (typeof baseRoot !== 'string' || baseRoot.trim() === '') throw new Error('BASE_ROOT_REQUIRED');

  const taskRoot = path.join(path.resolve(baseRoot), id);
  const workspacePath = path.join(taskRoot, 'workspace');
  const evidenceDir = evidenceDirectory ? path.resolve(evidenceDirectory) : path.join(taskRoot, 'evidence');
  const branchName = branch ? String(branch).trim() : taskBranchName(id);
  if (isDefaultBranch(branchName)) throw new Error('DEFAULT_BRANCH_FORBIDDEN');

  const remote = isRemoteRepo(repo);
  const capabilities = [...new Set([...(grants ?? TASK_GRANTS), ...(remote ? [Capability.NETWORK] : [])])];

  await fs.mkdir(taskRoot, { recursive: true });

  const exists = await pathExists(workspacePath);
  const empty = !exists || (await fs.readdir(workspacePath)).length === 0;
  if (!empty && !allowExisting) throw new Error('WORKSPACE_EXISTS');

  let cloneSummary = null;
  if (empty) {
    if (repo) {
      // Bootstrap engine rooted at taskRoot: `git clone <repo> workspace` creates
      // the checkout as a child directory, because the terminal sandbox writes
      // its `.tmp` scratch directory into its own root.
      const bootstrap = await createExecutionEngine({
        workspacePath: taskRoot,
        evidenceDirectory: path.join(evidenceDir, 'bootstrap'),
        grants: capabilities,
        limits,
      });
      cloneSummary = await bootstrap.git.clone(repo, { dest: 'workspace', ref });
    } else {
      await fs.mkdir(workspacePath, { recursive: true });
      const bootstrap = await createExecutionEngine({
        workspacePath,
        evidenceDirectory: path.join(evidenceDir, 'bootstrap'),
        grants: capabilities,
        limits,
      });
      await bootstrap.git.init();
    }
  }

  // Real engine on the checkout, with evidence kept OUTSIDE the Git tree so
  // checkpoints never stage run artifacts.
  const engine = await createExecutionEngine({
    workspacePath,
    evidenceDirectory: evidenceDir,
    grants: capabilities,
    limits,
  });
  const ready = await engine.git.createBranch(branchName);

  return {
    taskId: id,
    taskRoot,
    workspacePath,
    evidenceDirectory: evidenceDir,
    branch: ready.branch,
    branchCreated: ready.created,
    clone: cloneSummary
      ? { url: cloneSummary.url, ref: cloneSummary.ref, remote: cloneSummary.remote }
      : null,
    engine,
  };
}

export function taskGitStatus(handle) {
  return handle.engine.git.status();
}

export function taskGitDiff(handle) {
  return handle.engine.git.diff();
}

export function taskGitBranch(handle) {
  return handle.engine.git.branch();
}

const TASK_EVIDENCE_CONTAINER = 'semo0o-evidence';

/**
 * Evidence directory for a workspace. Evidence MUST live outside the Git tree so
 * a checkpoint can never stage it. A task workspace (`<taskRoot>/workspace`) keeps
 * its evidence in the sibling `<taskRoot>/evidence`; any other workspace falls
 * back to a central, non-repo location.
 */
export function taskEvidenceRoot(workspacePath, key, { evidenceRoot } = {}) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') throw new Error('WORKSPACE_PATH_REQUIRED');
  const resolved = path.resolve(workspacePath);
  const safeKey = key ? String(key).replace(/[^A-Za-z0-9._-]/g, '_') : path.basename(resolved);
  if (evidenceRoot) return path.join(path.resolve(evidenceRoot), safeKey);
  if (path.basename(resolved) === 'workspace') return path.join(path.dirname(resolved), 'evidence');
  return path.join(os.tmpdir(), TASK_EVIDENCE_CONTAINER, safeKey);
}

/**
 * Open an engine on an already-provisioned workspace without cloning or branching.
 * This is the link between the agent runtime and the Phase 1 task workspace: the
 * engine is rooted at the task checkout, and its evidence is written OUTSIDE it.
 */
export async function openTaskWorkspaceEngine({ workspacePath, evidenceDirectory, grants, limits } = {}) {
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') throw new Error('WORKSPACE_PATH_REQUIRED');
  const evidence = evidenceDirectory ? path.resolve(evidenceDirectory) : taskEvidenceRoot(workspacePath);
  return createExecutionEngine({
    workspacePath,
    evidenceDirectory: evidence,
    grants: grants ?? TASK_GRANTS,
    limits,
  });
}

/**
 * Build a resolver that hands each agent run its own isolated workspace engine.
 * It reads the task's workspace row, opens an engine whose evidence is OUTSIDE
 * the Git tree, and writes each run's evidence into its own sub-directory. The
 * engine is created fresh per run so permission state and evidence never leak
 * between runs.
 */
export function createTaskEngineResolver({ db, grants, limits, evidenceRoot } = {}) {
  if (!db) throw new Error('DB_REQUIRED');
  return async function resolveEngine({ task, run } = {}) {
    const workspace = task?.workspace_id ? db.get('SELECT * FROM workspaces WHERE id=?', task.workspace_id) : null;
    const workspacePath = workspace?.root_path || process.env.WORKSPACE_ROOT;
    if (!workspacePath) throw new Error('WORKSPACE_ROOT_REQUIRED');
    const key = workspace?.id || path.basename(path.resolve(workspacePath));
    const runKey = run?.id ? String(run.id).replace(/[^A-Za-z0-9._-]/g, '_') : 'engine';
    const evidenceDirectory = path.join(taskEvidenceRoot(workspacePath, key, { evidenceRoot }), runKey);
    return openTaskWorkspaceEngine({ workspacePath, evidenceDirectory, grants, limits });
  };
}
