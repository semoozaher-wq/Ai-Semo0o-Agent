import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyRuntimeDefaults, resolveRuntimeDefaults, resolveWritableWorkspaceRoot, runtimeDefaultCandidates, workspaceRootCandidates } from '../config/runtime-defaults.mjs';

// -----------------------------------------------------------------------------
// Regression tests for the Render ENV_VALIDATION_FAILED incident:
//   ENV_VALIDATION_FAILED:MISSING_SECRETS_MASTER_KEY,MISSING_DATABASE_FILE,MISSING_WORKSPACE_ROOT
//
// The two NON-SECRET storage paths (DATABASE_FILE / WORKSPACE_ROOT) now have safe
// container defaults, so only SECRETS_MASTER_KEY must be supplied by the operator.
// -----------------------------------------------------------------------------

test('resolveRuntimeDefaults returns absolute DATABASE_FILE and WORKSPACE_ROOT when unset', () => {
  const defaults = resolveRuntimeDefaults({});
  assert.ok(path.isAbsolute(defaults.DATABASE_FILE), 'DATABASE_FILE must be absolute');
  assert.ok(path.isAbsolute(defaults.WORKSPACE_ROOT), 'WORKSPACE_ROOT must be absolute');
  assert.equal(path.basename(defaults.DATABASE_FILE), 'agent.sqlite');
});

test('resolveRuntimeDefaults never overrides explicit values', () => {
  const defaults = resolveRuntimeDefaults({
    DATABASE_FILE: '/var/data/db/agent.sqlite',
    WORKSPACE_ROOT: '/var/data/workspace',
  });
  assert.equal(defaults.DATABASE_FILE, undefined);
  assert.equal(defaults.WORKSPACE_ROOT, undefined);
});

test('applyRuntimeDefaults fills only the missing storage keys and never a secret', () => {
  const env = { SECRETS_MASTER_KEY: 'operator-supplied-secret' };
  const applied = applyRuntimeDefaults(env, { logger: { warn() {} } });
  assert.ok(env.DATABASE_FILE, 'DATABASE_FILE should be filled');
  assert.ok(env.WORKSPACE_ROOT, 'WORKSPACE_ROOT should be filled');
  assert.equal(env.SECRETS_MASTER_KEY, 'operator-supplied-secret', 'secrets must never be defaulted');
  assert.deepEqual(Object.keys(applied).sort(), ['DATABASE_FILE', 'WORKSPACE_ROOT']);
});

test('runtimeDefaultCandidates prefers the repo data dir, then the OS temp dir', () => {
  const candidates = runtimeDefaultCandidates();
  assert.ok(candidates.DATABASE_FILE[0].endsWith(path.join('backend', 'data')));
  assert.equal(candidates.DATABASE_FILE[1], path.join(os.tmpdir(), 'semo0o'));
  assert.ok(candidates.WORKSPACE_ROOT[0].endsWith(path.join('backend', 'data', 'workspace')));
  assert.equal(candidates.WORKSPACE_ROOT[1], path.join(os.tmpdir(), 'semo0o', 'workspace'));
});

// -----------------------------------------------------------------------------
// Regression test for the "فشل التشغيل التنفيذي عبر الـBackend" incident:
// on Render's Free plan WORKSPACE_ROOT was set to /var/data/workspace, but no disk
// is mounted there, so `mkdir` in POST /projects failed with EACCES -> 500. The
// workspace root must be REPAIRED to a writable default instead of crashing.
// -----------------------------------------------------------------------------

test('resolveWritableWorkspaceRoot repairs an unwritable configured root', () => {
  // A path whose ancestor is a FILE can never be a directory, regardless of the
  // privileges of the user running the tests (unlike /var/data, which root could
  // create). This deterministically reproduces "configured but not writable".
  const blocker = path.join(os.tmpdir(), `semo0o-blocker-${process.pid}-${Date.now()}`);
  writeFileSync(blocker, 'not a directory');
  try {
    const configured = path.join(blocker, 'workspace');
    const env = { WORKSPACE_ROOT: configured };
    const resolved = resolveWritableWorkspaceRoot(env, { logger: { warn() {} } });
    assert.ok(resolved, 'a writable fallback must be found');
    assert.notEqual(path.resolve(resolved), path.resolve(configured));
    assert.ok(path.isAbsolute(resolved));
    // The fallback is one of the documented candidates.
    assert.ok(workspaceRootCandidates(env).includes(path.resolve(resolved)));
  } finally {
    rmSync(blocker, { force: true });
  }
});

test('applyRuntimeDefaults repairs an unwritable WORKSPACE_ROOT and never a secret', () => {
  const blocker = path.join(os.tmpdir(), `semo0o-blocker-${process.pid}-${Date.now()}`);
  writeFileSync(blocker, 'not a directory');
  try {
    const configured = path.join(blocker, 'workspace');
    const env = { SECRETS_MASTER_KEY: 'operator-supplied-secret', WORKSPACE_ROOT: configured };
    const applied = applyRuntimeDefaults(env, { logger: { warn() {} } });
    assert.notEqual(path.resolve(env.WORKSPACE_ROOT), path.resolve(configured), 'WORKSPACE_ROOT must be repaired');
    assert.equal(applied.WORKSPACE_ROOT, env.WORKSPACE_ROOT);
    assert.equal(env.SECRETS_MASTER_KEY, 'operator-supplied-secret', 'secrets must never be defaulted');
  } finally {
    rmSync(blocker, { force: true });
  }
});

test('applyRuntimeDefaults leaves an explicit writable WORKSPACE_ROOT untouched', () => {
  const dir = path.join(os.tmpdir(), `semo0o-writable-${process.pid}-${Date.now()}`);
  const env = { SECRETS_MASTER_KEY: 's', WORKSPACE_ROOT: dir };
  try {
    const applied = applyRuntimeDefaults(env, { logger: { warn() {} } });
    assert.equal(path.resolve(env.WORKSPACE_ROOT), path.resolve(dir));
    assert.equal(applied.WORKSPACE_ROOT, undefined, 'a writable root is not a "default"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
