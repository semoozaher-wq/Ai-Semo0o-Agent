/**
 * Runtime storage defaults.
 *
 * `assertEnv()` requires three values in production:
 *   - SECRETS_MASTER_KEY  (a real secret — MUST be supplied by the operator)
 *   - DATABASE_FILE       (absolute path to the SQLite file)
 *   - WORKSPACE_ROOT      (absolute path to the agent workspace)
 *
 * On a hosted platform (Render/Railway/Fly/...) the two *storage* paths have no
 * sensible operator-specific value, and Render's default environment does not set
 * them — which produced:
 *     ENV_VALIDATION_FAILED:MISSING_SECRETS_MASTER_KEY,MISSING_DATABASE_FILE,MISSING_WORKSPACE_ROOT
 *
 * This module fills in safe, container-appropriate defaults for the two
 * NON-SECRET storage paths so the backend can boot out of the box. It deliberately
 * NEVER touches SECRETS_MASTER_KEY (or any other secret): the secret check stays
 * fully enforced — we do not weaken `assertEnv` to hide a misconfiguration.
 *
 * Defaults (first writable candidate wins):
 *   DATABASE_FILE   -> <repo>/backend/data/agent.sqlite  then  <tmp>/semo0o/agent.sqlite
 *   WORKSPACE_ROOT  -> <repo>/backend/data/workspace     then  <tmp>/semo0o/workspace
 *
 * `<repo>/backend/data` is git-ignored and writable on Render's Free plan (the
 * checkout is writable even without a persistent disk). If it is not writable the
 * OS temp dir is used, so the process can always boot. An explicit env var always
 * wins and is never overridden.
 */
import { accessSync, constants as fsConstants, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// <repo> = the directory that contains `backend/` (two levels up from config/).
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DB_BASENAME = 'agent.sqlite';

function isWritableDirectory(dir) {
  try {
    return statSync(dir).isDirectory() && (accessSync(dir, fsConstants.W_OK), true);
  } catch {
    return false;
  }
}

// The database directory must be private (mode 0700): the app enforces this and
// refuses to start otherwise. A directory we create ourselves is always 0700; an
// existing directory is only accepted if it is already private.
function isPrivateDirectory(dir) {
  try {
    return (statSync(dir).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function ensureDirectory(dir, { private: mustBePrivate = false } = {}) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  return isWritableDirectory(dir) && (!mustBePrivate || isPrivateDirectory(dir));
}

function pickDirectory(candidates, { private: mustBePrivate = false } = {}) {
  for (const dir of candidates) {
    if (isWritableDirectory(dir)) {
      if (!mustBePrivate || isPrivateDirectory(dir)) return dir;
      continue; // exists but not private -> the DB client would reject it
    }
    if (ensureDirectory(dir, { private: mustBePrivate })) return dir;
  }
  return null;
}

// Exposed for tests: the ordered candidate directories for each storage path.
export function runtimeDefaultCandidates() {
  return {
    DATABASE_FILE: [path.join(APP_ROOT, 'backend', 'data'), path.join(os.tmpdir(), 'semo0o')],
    WORKSPACE_ROOT: [path.join(APP_ROOT, 'backend', 'data', 'workspace'), path.join(os.tmpdir(), 'semo0o', 'workspace')],
  };
}

// Ordered candidate workspace roots, mirroring `databaseFileCandidates()` in
// db/client.mjs:
//   1. WORKSPACE_ROOT  — the operator-controlled path (kept first so a real
//      persistent disk keeps working unchanged).
//   2. <repo>/backend/data/workspace — project-relative and git-ignored; writable
//      on Render Free (the checkout is writable even without a mounted disk).
//   3. <tmp>/semo0o/workspace — always-writable last resort, so project creation
//      can never fail with EACCES just because the configured disk is absent.
export function workspaceRootCandidates(env = process.env) {
  const candidates = [];
  if (env.WORKSPACE_ROOT) candidates.push(env.WORKSPACE_ROOT);
  candidates.push(...runtimeDefaultCandidates().WORKSPACE_ROOT);
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

// Resolve the first candidate workspace root that is writable, creating it when
// needed. Never throws EACCES: an unusable configured root (for example
// `/var/data/workspace` on Render's Free plan, where no disk is mounted) is
// skipped and a safe container default is returned instead. This is the workspace
// analogue of `resolveDatabaseFile()` and is what stops `POST /projects` from
// crashing with a 500 when WORKSPACE_ROOT points at an unmounted disk.
export function resolveWritableWorkspaceRoot(env = process.env, { logger = console } = {}) {
  const configured = env.WORKSPACE_ROOT ? path.resolve(env.WORKSPACE_ROOT) : null;
  for (const dir of workspaceRootCandidates(env)) {
    if (isWritableDirectory(dir) || ensureDirectory(dir)) {
      if (configured && dir !== configured) {
        logger.warn?.(`env: configured WORKSPACE_ROOT '${configured}' is not writable; falling back to '${dir}'`);
      }
      return dir;
    }
  }
  return null;
}

// Returns the defaults that WOULD be applied (does not mutate `env`).
export function resolveRuntimeDefaults(env = process.env) {
  const candidates = runtimeDefaultCandidates();
  const defaults = {};
  if (!env.DATABASE_FILE) {
    const dir = pickDirectory(candidates.DATABASE_FILE, { private: true });
    if (dir) defaults.DATABASE_FILE = path.join(dir, DB_BASENAME);
  }
  if (!env.WORKSPACE_ROOT) {
    const dir = pickDirectory(candidates.WORKSPACE_ROOT);
    if (dir) defaults.WORKSPACE_ROOT = dir;
  }
  return defaults;
}

// Fills missing storage paths in `env` (defaults to process.env) and logs each
// default it applies. Returns the map of applied defaults.
//
// It also REPAIRS a `WORKSPACE_ROOT` that is set but not writable (e.g. an
// unmounted `/var/data/workspace` on Render's Free plan): the configured value is
// replaced with the first writable container default. An explicit *writable* root
// is never touched, so operators who mount a real disk keep their path.
export function applyRuntimeDefaults(env = process.env, { logger = console } = {}) {
  const defaults = resolveRuntimeDefaults(env);
  for (const [key, value] of Object.entries(defaults)) {
    env[key] = value;
    logger.warn?.(`env: ${key} was not set; using container default '${value}'`);
  }
  if (env.WORKSPACE_ROOT) {
    const writable = resolveWritableWorkspaceRoot(env, { logger });
    if (writable && path.resolve(writable) !== path.resolve(env.WORKSPACE_ROOT)) {
      env.WORKSPACE_ROOT = writable;
      defaults.WORKSPACE_ROOT = writable;
    }
  }
  return defaults;
}
