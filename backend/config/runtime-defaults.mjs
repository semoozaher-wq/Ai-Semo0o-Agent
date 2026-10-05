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
export function applyRuntimeDefaults(env = process.env, { logger = console } = {}) {
  const defaults = resolveRuntimeDefaults(env);
  for (const [key, value] of Object.entries(defaults)) {
    env[key] = value;
    logger.warn?.(`env: ${key} was not set; using container default '${value}'`);
  }
  return defaults;
}
