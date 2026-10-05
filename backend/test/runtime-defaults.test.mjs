import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyRuntimeDefaults, resolveRuntimeDefaults, runtimeDefaultCandidates } from '../config/runtime-defaults.mjs';

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
