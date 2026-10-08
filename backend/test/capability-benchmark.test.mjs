import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CAPABILITY_DEFINITIONS,
  DEFAULT_RUNTIME_FLAGS,
  buildCapabilityScorecard,
  collectCapabilitySignals,
  defineAgentBenchmark,
  defineCapabilityBenchmark,
  describeScorecard,
  loadProofArtifacts,
  normalizeProof,
  runAgentBenchmark,
  runCapabilityBenchmark,
} from '../ops/capability-benchmark.mjs';

const ALL_LIVE_TOOLS = ['code.analyze', 'code.impact', 'code.changeset', 'code.reason', 'browser.run'];

// A proof object where every wired benchmark passed end-to-end.
const FULL_PROOF = {
  agentBenchmark: { passed: true, agentLoop: { summary: { passRate: 100 } }, multiAgent: { summary: { passRate: 100 } }, longRunning: { summary: { passRate: 100 } }, codeIntelligence: { summary: { passRate: 100 } }, selfHealing: { summary: { passRate: 100 } }, integrations: { summary: { passRate: 100 } } },
  browserE2e: { passed: true },
  capabilityBenchmark: true,
};

/* ------------------------------ scorecard -------------------------------- */

test('capability: the catalogue covers exactly the 13 promised capabilities', () => {
  assert.equal(CAPABILITY_DEFINITIONS.length, 13);
  const ids = CAPABILITY_DEFINITIONS.map((definition) => definition.id);
  for (const id of ['codebase-understanding', 'dependency-graph', 'impact-analysis', 'change-intelligence', 'long-running', 'self-healing', 'deep-reasoning', 'multi-step-verification', 'computer-use', 'multi-agent', 'agent-evaluation', 'integrations', 'capability-benchmarking']) {
    assert.ok(ids.includes(id), `missing capability ${id}`);
  }
});

test('capability: an empty signal set is scored honestly (tool-backed caps unwired, nothing proven)', () => {
  const scorecard = buildCapabilityScorecard({});
  assert.equal(scorecard.capabilities.length, 13);
  assert.equal(scorecard.summary.total, 13);
  // No tools are live -> every tool-backed capability must be unwired at score 0.
  const browser = scorecard.capabilities.find((capability) => capability.id === 'computer-use');
  assert.equal(browser.status, 'unwired');
  assert.equal(browser.score, 0);
  const analyze = scorecard.capabilities.find((capability) => capability.id === 'codebase-understanding');
  assert.equal(analyze.status, 'unwired');
  // Integrations with no connectors configured is honestly "partial", not live.
  const integrations = scorecard.capabilities.find((capability) => capability.id === 'integrations');
  assert.equal(integrations.status, 'partial');
  // Runtime-flag capabilities are WIRED (exist in code) but never PROVEN without proof.
  const longRunning = scorecard.capabilities.find((capability) => capability.id === 'long-running');
  assert.equal(longRunning.status, 'wired');
  assert.equal(longRunning.proven, false);
  assert.equal(scorecard.summary.proven, 0);
  assert.equal(scorecard.provenScore, 0);
  assert.ok(scorecard.score < 100, `expected a sub-100 honest score, got ${scorecard.score}`);
  assert.notEqual(scorecard.level, 'production');
  assert.match(describeScorecard(scorecard), /0 proven end-to-end/);
});

test('capability: a runtime flag alone is wired, never proven (no flag-only claim)', () => {
  const scorecard = buildCapabilityScorecard({ runtime: { multiAgent: true } });
  const multiAgent = scorecard.capabilities.find((capability) => capability.id === 'multi-agent');
  assert.equal(multiAgent.status, 'wired');
  assert.equal(multiAgent.wired, true);
  assert.equal(multiAgent.proven, false);
  assert.ok(multiAgent.evidence.includes('proof:agent-benchmark:multi-agent=false'));
});

test('capability: full live signals WITHOUT proof are wired, not proven', () => {
  const scorecard = buildCapabilityScorecard({
    tools: { live: ALL_LIVE_TOOLS, partial: [], unwired: [], failed: [] },
    integrations: { configured: ['github', 'browser'], total: 8 },
  });
  assert.equal(scorecard.summary.proven, 0);
  assert.equal(scorecard.summary.wired, 13);
  assert.equal(scorecard.provenScore, 0);
  assert.equal(scorecard.score, 70);
  assert.equal(scorecard.level, 'strong');
});

test('capability: end-to-end proof upgrades wired capabilities to proven', () => {
  const scorecard = buildCapabilityScorecard({
    tools: { live: ALL_LIVE_TOOLS, partial: [], unwired: [], failed: [] },
    integrations: { configured: ['github', 'browser'], total: 8 },
    proof: FULL_PROOF,
  });
  assert.equal(scorecard.summary.proven, 13);
  assert.equal(scorecard.summary.wired, 0); // every capability now has a real end-to-end proof
  assert.equal(scorecard.summary.unwired, 0);
  assert.ok(scorecard.score >= 90, `expected a production score, got ${scorecard.score}`);
  assert.equal(scorecard.level, 'production');
  assert.equal(scorecard.provenScore, 100);
  // Every proven capability carries the proof source in its evidence.
  const browser = scorecard.capabilities.find((capability) => capability.id === 'computer-use');
  assert.equal(browser.status, 'proven');
  assert.ok(browser.evidence.includes('proof:browser-e2e=true'));
  const selfHealing = scorecard.capabilities.find((capability) => capability.id === 'self-healing');
  assert.equal(selfHealing.status, 'proven');
  assert.equal(selfHealing.proven, true);
  assert.ok(selfHealing.evidence.includes('proof:agent-benchmark:self-healing=true'));
  const integrations = scorecard.capabilities.find((capability) => capability.id === 'integrations');
  assert.equal(integrations.status, 'proven');
  assert.ok(integrations.evidence.includes('proof:agent-benchmark:integrations=true'));
  assert.match(describeScorecard(scorecard), /13 proven end-to-end/);
});

test('capability: a runtime flag override degrades only that capability', () => {
  const scorecard = buildCapabilityScorecard({
    tools: { live: ALL_LIVE_TOOLS, partial: [], unwired: [], failed: [] },
    runtime: { longRunning: false },
  });
  const longRunning = scorecard.capabilities.find((capability) => capability.id === 'long-running');
  assert.equal(longRunning.status, 'unwired');
  assert.equal(longRunning.score, 0);
  assert.ok(scorecard.score < 100);
  // Every other runtime capability stays wired.
  const multiAgent = scorecard.capabilities.find((capability) => capability.id === 'multi-agent');
  assert.equal(multiAgent.status, 'wired');
});

test('capability: a failed tool is surfaced as failed, never hidden as partial', () => {
  const scorecard = buildCapabilityScorecard({ tools: { live: [], partial: [], unwired: [], failed: ['code.impact'] } });
  const impact = scorecard.capabilities.find((capability) => capability.id === 'impact-analysis');
  assert.equal(impact.status, 'failed');
  assert.equal(impact.score, 0);
  assert.equal(scorecard.summary.failed, 1);
});

test('capability: collectCapabilitySignals derives honest signals from live objects', () => {
  const signals = collectCapabilitySignals({
    tools: { status: () => ({ live: ['code.analyze'], partial: ['code.changeset'], unwired: ['browser.run'], failed: [] }) },
    llm: { status: () => [{ id: 'a', configured: true }, { id: 'b', configured: false }, { id: 'c', configured: true, healthy: false }] },
    integrations: { github: { configured: true }, tools: { live: ['image.generate'] } },
  });
  assert.deepEqual(signals.tools.live, ['code.analyze']);
  assert.deepEqual(signals.tools.partial, ['code.changeset']);
  assert.deepEqual(signals.tools.unwired, ['browser.run']);
  assert.equal(signals.models.total, 3);
  assert.equal(signals.models.configured, 2);
  assert.equal(signals.models.healthy, 1);
  assert.ok(signals.integrations.configured.includes('github'));
  assert.ok(signals.integrations.configured.includes('image'));
  assert.equal(signals.integrations.total, 8);
  assert.deepEqual(signals.proof, {});
});

test('capability: collectCapabilitySignals degrades to honest defaults with no runtime', () => {
  const signals = collectCapabilitySignals();
  assert.deepEqual(signals.tools, { live: [], partial: [], unwired: [], failed: [] });
  assert.equal(signals.models.total, 0);
  assert.deepEqual(signals.integrations.configured, []);
  assert.deepEqual(signals.runtime, {});
  assert.deepEqual(signals.proof, {});
});

/* ------------------------------ proof input ------------------------------ */

test('capability: normalizeProof derives honest booleans from raw benchmark reports', () => {
  const proof = normalizeProof({ agentBenchmark: FULL_PROOF.agentBenchmark, browserE2e: { passed: true }, capabilityBenchmark: true });
  assert.equal(proof.agentBenchmark.passed, true);
  assert.equal(proof.agentBenchmark.scenarios.agentLoop, true);
  assert.equal(proof.agentBenchmark.scenarios.multiAgent, true);
  assert.equal(proof.agentBenchmark.scenarios.longRunning, true);
  assert.equal(proof.agentBenchmark.scenarios.codeIntelligence, true);
  assert.equal(proof.agentBenchmark.scenarios.selfHealing, true);
  assert.equal(proof.agentBenchmark.scenarios.integrations, true);
  assert.equal(proof.browserE2e.passed, true);
  assert.equal(proof.capabilityBenchmark, true);

  // A missing / partial report degrades to false — never a fabricated pass.
  const empty = normalizeProof({});
  assert.equal(empty.agentBenchmark.passed, false);
  assert.equal(empty.agentBenchmark.scenarios.codeIntelligence, false);
  assert.equal(empty.browserE2e.passed, false);
  assert.equal(empty.capabilityBenchmark, false);
  const partial = normalizeProof({ agentBenchmark: { passed: false, agentLoop: { summary: { passRate: 50 } } } });
  assert.equal(partial.agentBenchmark.scenarios.agentLoop, false);
});

test('capability: loadProofArtifacts reads the real benchmark reports from a directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'capability-proof-'));
  try {
    // No reports present -> nothing proven.
    const missing = loadProofArtifacts(dir, { capabilityBenchmark: true });
    assert.equal(missing.agentBenchmark.passed, false);
    assert.equal(missing.browserE2e.passed, false);
    assert.equal(missing.capabilityBenchmark, true);

    await writeFile(path.join(dir, 'agent-benchmark.report.json'), JSON.stringify({ passed: true, agentLoop: { summary: { passRate: 100 } }, multiAgent: { summary: { passRate: 100 } }, longRunning: { summary: { passRate: 100 } }, codeIntelligence: { summary: { passRate: 100 } }, selfHealing: { summary: { passRate: 100 } }, integrations: { summary: { passRate: 100 } } }), 'utf8');
    await writeFile(path.join(dir, 'browser-e2e.report.json'), JSON.stringify({ passed: true }), 'utf8');
    const loaded = loadProofArtifacts(dir, { capabilityBenchmark: true });
    assert.equal(loaded.agentBenchmark.passed, true);
    assert.equal(loaded.agentBenchmark.scenarios.multiAgent, true);
    assert.equal(loaded.agentBenchmark.scenarios.selfHealing, true);
    assert.equal(loaded.agentBenchmark.scenarios.integrations, true);
    assert.equal(loaded.browserE2e.passed, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------------- capability bench ---------------------------- */

test('capability: the scorecard is turned into a reproducible benchmark report', async () => {
  const { scorecard, report } = await runCapabilityBenchmark({
    tools: { live: ALL_LIVE_TOOLS, partial: [], unwired: [], failed: [] },
    integrations: { configured: ['github', 'browser'], total: 8 },
    proof: FULL_PROOF,
  });
  assert.ok(scorecard.score >= 90 && scorecard.score <= 100, `expected 90..100, got ${scorecard.score}`);
  assert.equal(scorecard.level, 'production');
  assert.equal(report.summary.total, 13);
  assert.equal(report.summary.passed, 13);
  assert.equal(report.summary.score, 100);
  // Each capability is a weighted task.
  assert.equal(report.tasks.length, 13);
  assert.ok(report.summary.byEvaluator.available.passed === 13);
});

test('capability: an unwired capability fails the benchmark (no silent pass)', async () => {
  const { report } = await runCapabilityBenchmark({ tools: { live: [], partial: [], unwired: ALL_LIVE_TOOLS, failed: [] } });
  const browserTask = report.tasks.find((task) => task.id === 'computer-use');
  assert.equal(browserTask.ok, false);
  assert.ok(report.summary.passed < 13);
});

/* ------------------------------ agent bench ------------------------------ */

test('agent bench: tasks are derived from the real index, never hard-coded', () => {
  const full = defineAgentBenchmark({ intelligence: { files: ['src/app.ts', 'src/app.test.ts'], symbols: [{ name: 'boot' }] } });
  const ids = full.tasks.map((task) => task.id);
  assert.deepEqual(ids, ['analyze', 'changeset', 'impact', 'reason']);
  // The analyze task targets the first non-test source file.
  assert.equal(full.tasks.find((task) => task.id === 'analyze').args.path, 'src/app.ts');
  assert.equal(full.tasks.find((task) => task.id === 'impact').args.changedFiles[0], 'src/app.ts');
  assert.equal(full.tasks.find((task) => task.id === 'reason').args.question, 'boot');

  // With an empty index only the index-independent tasks remain.
  const empty = defineAgentBenchmark({ intelligence: { files: [], symbols: [] } });
  assert.deepEqual(empty.tasks.map((task) => task.id), ['analyze', 'changeset']);
});

test('agent bench: runAgentBenchmark drives the real tool registry and scores honestly', async () => {
  const calls = [];
  const tools = {
    async run(toolId, args) {
      calls.push({ toolId, args });
      return { ok: true, output: { toolId, args } };
    },
  };
  const { report, workspace } = await runAgentBenchmark({
    tools,
    root: '/tmp/ws',
    intelligence: { files: ['src/app.ts'], symbols: [{ name: 'boot' }] },
  });
  assert.equal(workspace.files, 1);
  assert.equal(workspace.symbols, 1);
  assert.equal(report.summary.total, 4);
  assert.equal(report.summary.passed, 4);
  assert.equal(report.summary.score, 100);
  assert.deepEqual(calls.map((call) => call.toolId), ['code.analyze', 'code.changeset', 'code.impact', 'code.reason']);
});

test('agent bench: a tool that reports ok:false fails its task', async () => {
  const tools = { async run(toolId) { return { ok: toolId !== 'code.changeset', output: { toolId }, error: toolId === 'code.changeset' ? 'boom' : undefined }; } };
  const { report } = await runAgentBenchmark({ tools, intelligence: { files: ['src/app.ts'], symbols: [] } });
  const changeset = report.tasks.find((task) => task.id === 'changeset');
  assert.equal(changeset.ok, false);
  assert.ok(report.summary.passed < report.summary.total);
});

test('agent bench: a throwing tool is scored as a failure, not skipped', async () => {
  const tools = { async run(toolId) { if (toolId === 'code.impact') throw new Error('impact down'); return { ok: true, output: {} }; } };
  const { report } = await runAgentBenchmark({ tools, intelligence: { files: ['src/app.ts'], symbols: [] } });
  const impact = report.tasks.find((task) => task.id === 'impact');
  assert.equal(impact.ok, false);
  assert.match(impact.error, /impact down/);
});

test('agent bench: runAgentBenchmark requires a real tool registry', async () => {
  await assert.rejects(() => runAgentBenchmark({}), /TOOLS_REQUIRED/);
  await assert.rejects(() => runAgentBenchmark({ tools: {} }), /TOOLS_REQUIRED/);
});

test('capability: default runtime flags describe the wired reality', () => {
  for (const flag of ['dependencyGraph', 'longRunning', 'selfHealing', 'multiStepVerification', 'multiAgent', 'agentEvaluation', 'capabilityBenchmarking']) {
    assert.equal(DEFAULT_RUNTIME_FLAGS[flag], true, `${flag} should default to true`);
  }
});
