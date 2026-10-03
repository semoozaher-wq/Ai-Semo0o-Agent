import { Database } from './db/client.mjs';
import { RunQueue } from './queue/queue.mjs';
import { createCodeRunHandler } from './runners/code-runner.mjs';

const db = new Database();
const queue = new RunQueue(db, { pollMs: Number(process.env.WORKER_POLL_MS || 250) });
queue.register('code.run', createCodeRunHandler(db));
queue.start();
console.log(`agent worker ${queue.workerId} started`);
const shutdown = () => { queue.stop(); db.close(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
