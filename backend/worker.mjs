import { Database } from './db/client.mjs';
import { RunQueue } from './queue/queue.mjs';
import { createCodeRunHandler } from './runners/code-runner.mjs';
import { createLiveToolRegistry } from './tools/registry.mjs';
import { createLLMRouter } from './llm/providers.mjs';
import { createAgentRunHandler } from './agent/runtime.mjs';
import { modelCost } from './runtime-shared.mjs';
import { assertEnv } from './config/env.mjs';
import { applyRuntimeDefaults } from './config/runtime-defaults.mjs';

// Same storage defaults as the server: fill DATABASE_FILE / WORKSPACE_ROOT when
// unset (never SECRETS_MASTER_KEY), then run the full production validation.
applyRuntimeDefaults();
assertEnv();
if (process.env.NODE_ENV === 'production') process.umask(0o077);
const db = new Database();
const queue = new RunQueue(db, { pollMs: Number(process.env.WORKER_POLL_MS || 250), leaseMs: Number(process.env.WORKER_LEASE_MS || 900000), maxAttempts: Number(process.env.WORKER_MAX_ATTEMPTS || 3), concurrency: Number(process.env.WORKER_CONCURRENCY || 1) });
queue.register('code.run', createCodeRunHandler(db));
const llm = createLLMRouter();
const tools = createLiveToolRegistry({ db, llm });
queue.register('agent.run', createAgentRunHandler({ db, tools, llm, costFor: modelCost }));
queue.start();
console.log(`agent worker ${queue.workerId} started`);
const shutdown = () => { queue.stop(); db.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
