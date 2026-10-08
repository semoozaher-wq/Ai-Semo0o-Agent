import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOOL_RISKS,
  assertToolExecutionAllowed,
  classifyToolRisk,
  degradedCapabilities,
  requiresApproval,
  riskPolicy,
  validateStartupConfig,
} from '../agent/safety.mjs';

/**
 * Production safety primitives: risk classification, approval boundaries,
 * startup validation and graceful degradation. Pure policy, tested directly.
 */

/* ------------------------------ risk classes ------------------------------ */

test('TOOL_RISKS enumerates the risk levels from least to most dangerous', () => {
  assert.deepEqual([...TOOL_RISKS], ['read', 'write', 'execute', 'external', 'destructive']);
});

test('classifyToolRisk maps each tool to its risk level', () => {
  assert.equal(classifyToolRisk('git.push'), 'destructive');
  assert.equal(classifyToolRisk('calendar.schedule'), 'destructive');
  assert.equal(classifyToolRisk('code.run'), 'execute');
  assert.equal(classifyToolRisk('files.write'), 'write');
  assert.equal(classifyToolRisk('web.search'), 'external');
  assert.equal(classifyToolRisk('files.read'), 'read');
  assert.equal(classifyToolRisk('totally.unknown'), 'read', 'unknown tools default to the safest class');
});

/* --------------------------- approval boundaries -------------------------- */

test('requiresApproval always gates destructive actions', () => {
  assert.equal(requiresApproval('git.push'), true);
  assert.equal(requiresApproval('email.send'), true);
  assert.equal(requiresApproval('calendar.schedule'), true);
});

test('requiresApproval gates every catalog-dangerous tool', () => {
  assert.equal(requiresApproval('files.write'), true);
  assert.equal(requiresApproval('terminal.run'), true);
  assert.equal(requiresApproval('memory.write'), true);
});

test('requiresApproval never gates a read-only action', () => {
  assert.equal(requiresApproval('files.read'), false);
  assert.equal(requiresApproval('web.search'), false);
});

test('requiresApproval bypasses tools the run was explicitly approved for', () => {
  assert.equal(requiresApproval('git.push', { approvedTools: new Set(['git.push']) }), false);
  assert.equal(requiresApproval('files.write', { approvedTools: ['files.write'] }), false);
});

/* ---------------------------- fail-closed guard --------------------------- */

test('assertToolExecutionAllowed returns true for a permitted tool', () => {
  assert.equal(assertToolExecutionAllowed('files.read'), true);
  assert.equal(assertToolExecutionAllowed('git.push', { approvedTools: new Set(['git.push']) }), true);
});

test('assertToolExecutionAllowed throws a machine-readable error for a gated tool', () => {
  assert.throws(
    () => assertToolExecutionAllowed('git.push'),
    (error) => {
      assert.equal(error.code, 'AGENT_APPROVAL_REQUIRED');
      assert.equal(error.toolId, 'git.push');
      assert.equal(error.risk, 'destructive');
      assert.match(error.message, /AGENT_APPROVAL_REQUIRED:git\.push/);
      return true;
    },
  );
});

/* ------------------------------- risk policy ------------------------------ */

test('riskPolicy exposes a serialisable table of gated tools', () => {
  const policy = riskPolicy();
  assert.equal(policy['git.push'].risk, 'destructive');
  assert.equal(policy['git.push'].requiresApproval, true);
  assert.equal(policy['files.read'], undefined, 'read-only tools are not listed in the policy table');
});

/* --------------------------- startup validation --------------------------- */

test('validateStartupConfig reuses validateEnv and adds graceful-degradation warnings', () => {
  const result = validateStartupConfig({ NODE_ENV: 'production', SECRETS_MASTER_KEY: 'x'.repeat(48), DATABASE_FILE: '/tmp/agent.sqlite', WORKSPACE_ROOT: '/tmp', ALLOWED_ORIGIN: 'https://app.example.com' });
  assert.equal(result.ok, true, 'a complete production config must validate');
  assert.ok(result.warnings.includes('METRICS_TOKEN_NOT_SET'));
  assert.ok(result.warnings.includes('SEARCH_PROVIDER_NOT_CONFIGURED'));
  assert.ok(result.warnings.includes('NO_LLM_PROVIDER_CONFIGURED'));
});

test('validateStartupConfig still reports fatal misconfiguration from validateEnv', () => {
  const result = validateStartupConfig({ NODE_ENV: 'production' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('MISSING_SECRETS_MASTER_KEY'));
});

/* ---------------------------- graceful degradation ------------------------ */

test('degradedCapabilities reports degradation when no provider is configured', () => {
  const degraded = degradedCapabilities({ tools: null, llm: null });
  assert.equal(degraded.degraded, true);
  assert.ok(degraded.unavailable.includes('llm'));
  assert.equal(degraded.reason, 'degraded:llm');
});

test('degradedCapabilities reports nominal when a provider and all tools are available', () => {
  const llm = { status: () => [{ id: 'openai', configured: true }] };
  const tools = { status: () => ({ unwired: [], failed: [] }) };
  const report = degradedCapabilities({ tools, llm });
  assert.equal(report.degraded, false);
  assert.equal(report.reason, 'nominal');
  assert.deepEqual(report.configuredProviders, ['openai']);
});

test('degradedCapabilities surfaces unwired and failed tools', () => {
  const llm = { status: () => [{ id: 'openai', configured: true }] };
  const tools = { status: () => ({ unwired: ['media.analyze'], failed: ['github.pr.create'] }) };
  const report = degradedCapabilities({ tools, llm });
  assert.equal(report.degraded, true);
  assert.ok(report.unavailable.includes('tools:1'));
  assert.ok(report.unavailable.includes('failed_tools:1'));
});

test('degradedCapabilities never throws when a status provider is malformed', () => {
  const llm = { status: () => { throw new Error('boom'); } };
  const tools = { status: () => { throw new Error('boom'); } };
  const report = degradedCapabilities({ tools, llm });
  assert.equal(report.degraded, true);
  assert.equal(report.reason, 'degraded:llm');
});
