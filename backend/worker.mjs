import { Database } from './db/client.mjs';
import { RunQueue } from './queue/queue.mjs';
import { createCodeRunHandler } from './runners/code-runner.mjs';
import { createLiveToolRegistry } from './tools/registry.mjs';
import { createLLMRouter } from './llm/providers.mjs';
import { createAgentRunHandler } from './agent/runtime.mjs';
import { createTaskEngineResolver } from '../execution-core/task-workspace.mjs';
import { modelCost } from './runtime-shared.mjs';
import { assertEnv } from './config/env.mjs';
import { applyRuntimeDefaults } from './config/runtime-defaults.mjs';
import { redactDeep, collectKnownSecrets } from './secrets/vault.mjs';

/**
 * Assemble a fully-wired worker runtime.
 *
 * This is the SAME handler set and the SAME secret redaction as the in-process
 * server worker (`createApp`), so a run processed by a dedicated worker process
 * is indistinguishable from — and exactly as safe as — one processed by the
 * server. Exported so it can be unit-tested without booting a long-lived process.
 *
 * @param {object}   opts
 * @param {Database} opts.db          Open database handle (required).
 * @param {object}   [opts.llm]       LLM router (defaults to the live router).
 * @param {Function} [opts.codeRunner] Optional code runner override.
 * @param {string[]} [opts.secrets]   Known secret values to redact (defaults to
 *                                    the environment-derived set).
 * @param {number}   [opts.pollMs]    Queue poll interval.
 * @param {number}   [opts.leaseMs]   Queue lease duration.
 * @param {number}   [opts.maxAttempts] Max attempts per run.
 * @param {number}   [opts.concurrency] Parallel runs.
 */
export function createWorkerRuntime({ db, llm = createLLMRouter(), codeRunner, secrets, pollMs, leaseMs, maxAttempts, concurrency } = {}) {
  if (!db) throw new Error('WORKER_DB_REQUIRED');
  // Known secret values are resolved once and shared by the queue (result_json)
  // and the agent runtime (evidence / events / checkpoint) so both persist
  // redacted data. Tests may inject an explicit `secrets` list.
  const knownSecrets = Array.isArray(secrets) ? secrets : collectKnownSecrets();
  const redact = (value) => redactDeep(value, knownSecrets);
  const queue = new RunQueue(db, {
    pollMs: Number(pollMs ?? (process.env.WORKER_POLL_MS || 250)),
    leaseMs: Number(leaseMs ?? (process.env.WORKER_LEASE_MS || 900000)),
    maxAttempts: Number(maxAttempts ?? (process.env.WORKER_MAX_ATTEMPTS || 3)),
    concurrency: Number(concurrency ?? (process.env.WORKER_CONCURRENCY || 1)),
    // Wire the SAME redaction the server uses. Without this the worker would
    // persist unredacted `result_json` (including thrown-error messages), which
    // is a secret-leak inconsistency between the server and the worker.
    redact,
  });
  queue.register('code.run', codeRunner ?? createCodeRunHandler(db));
  const tools = createLiveToolRegistry({ db, codeRunner, llm, engineAvailable: true });
  // Link every agent run to its isolated per-task workspace engine.
  queue.register('agent.run', createAgentRunHandler({ db, tools, llm, costFor: modelCost, resolveEngine: createTaskEngineResolver({ db }), secrets: knownSecrets }));
  return { queue, tools, llm, knownSecrets };
}

if (process.argv[1]?.endsWith('backend/worker.mjs')) {
  // Same storage defaults as the server: fill DATABASE_FILE / WORKSPACE_ROOT when
  // unset (never SECRETS_MASTER_KEY), then run the full production validation.
  applyRuntimeDefaults();
  assertEnv();
  if (process.env.NODE_ENV === 'production') process.umask(0o077);
  const db = new Database();
  const { queue } = createWorkerRuntime({ db });
  queue.start();
  console.log(`agent worker ${queue.workerId} started`);
  const shutdown = () => { queue.stop(); db.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
