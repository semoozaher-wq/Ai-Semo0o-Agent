#!/usr/bin/env node
/**
 * scripts/capability-benchmark.mjs — Capability Benchmarking (real evidence).
 *
 * Produces an honest capability scorecard for the 13 product capabilities by
 * reading REAL runtime signals — the live tool registry state, the configured
 * model providers and the integration connectors — then scores it with the
 * shared eval engine (phase2-core/eval.mjs). Nothing is asserted that is not
 * backed by a live signal.
 *
 * Usage:
 *   node --experimental-sqlite scripts/capability-benchmark.mjs [--out scorecard.json] [--min 70]
 * Exit code is non-zero when the score is below `--min` (default 0 = report only).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLiveToolRegistry } from '../backend/tools/registry.mjs';
import { createLLMRouter } from '../backend/llm/providers.mjs';
import { billingProviderStatus } from '../backend/billing/stripe.mjs';
import { githubStatus } from '../backend/github/service.mjs';
import { embeddingStatus } from '../backend/memory/embeddings.mjs';
import { errorTrackerStatus } from '../backend/observability/error-tracking.mjs';
import {
  buildCapabilityScorecard,
  collectCapabilitySignals,
  describeScorecard,
  runCapabilityBenchmark,
} from '../backend/ops/capability-benchmark.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const outFile = arg('--out', path.join(REPO_ROOT, 'capability-scorecard.json'));
const min = Number(arg('--min', '0')) || 0;

// Mirror the server's `/integrations/status` view (minus the tenant-scoped DB
// connection, which a CLI has no session for). Same building blocks, same truth.
function integrationView(tools) {
  const toolStatus = tools.status?.() ?? { live: [], partial: [], unwired: [], failed: [] };
  return {
    tools: { live: toolStatus.live ?? [], partial: toolStatus.partial ?? [], unwired: toolStatus.unwired ?? [], failed: toolStatus.failed ?? [] },
    billing: billingProviderStatus(process.env),
    github: githubStatus(process.env),
    embeddings: embeddingStatus(process.env),
    errorTracking: errorTrackerStatus(process.env),
    browser: { cdpConfigured: Boolean(process.env.BROWSER_CDP_URL), localLaunch: process.env.BROWSER_LAUNCH_LOCAL === 'true' },
  };
}

function safeRouter() {
  try {
    return createLLMRouter();
  } catch {
    return { status: () => [] };
  }
}

async function main() {
  const tools = createLiveToolRegistry({ llm: safeRouter() });
  const llm = safeRouter();
  const integrations = integrationView(tools);

  const signals = collectCapabilitySignals({ tools, llm, integrations });
  const { scorecard, report } = await runCapabilityBenchmark(signals);
  const output = { scorecard, benchmark: report };

  process.stdout.write(`${describeScorecard(scorecard)}\n\n`);
  for (const capability of scorecard.capabilities) {
    process.stdout.write(`  [${String(capability.score).padStart(3)}] ${capability.status.padEnd(8)} ${capability.name}\n`);
  }
  process.stdout.write(`\nbenchmark: ${report.summary.passed}/${report.summary.total} passed (score ${report.summary.score})\n`);

  const { writeFile } = await import('node:fs/promises');
  await writeFile(outFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`Scorecard written to ${outFile}\n`);

  if (scorecard.score < min) {
    process.stderr.write(`capability score ${scorecard.score} is below the required minimum ${min}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`capability-benchmark failed: ${error?.stack || error}\n`);
  process.exit(1);
});
