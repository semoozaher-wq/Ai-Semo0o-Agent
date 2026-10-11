/**
 * Operator CLI for cloud (PostgreSQL) snapshot persistence.
 *
 *   node --experimental-sqlite backend/ops/cloud-db.mjs status
 *   node --experimental-sqlite backend/ops/cloud-db.mjs sync   [--file <db>]
 *   node --experimental-sqlite backend/ops/cloud-db.mjs restore [--file <db>]
 *
 * `sync`   uploads a fresh snapshot of the local SQLite database.
 * `restore` pulls the newest snapshot back, but ONLY into an empty database (it
 *           never overwrites live data); move the local file aside first if you
 *           really want to force it.
 * `status` reports whether cloud persistence is configured and reachable.
 *
 * Requires DATABASE_URL. The optional `pg` driver must be installed for `sync`
 * and `restore` (see backend/db/cloud-persistence.mjs).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDatabaseFile } from '../db/client.mjs';
import { resolveCloudStore, restoreFromCloudIfEmpty, syncSnapshotToCloud } from '../db/cloud-persistence.mjs';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function usage() {
  return [
    'Usage:',
    '  node --experimental-sqlite backend/ops/cloud-db.mjs status',
    '  node --experimental-sqlite backend/ops/cloud-db.mjs sync [--file <database-file>]',
    '  node --experimental-sqlite backend/ops/cloud-db.mjs restore [--file <database-file>]',
    'DATABASE_URL must be set. `restore` only writes into an empty database.',
  ].join('\n');
}

async function main(argv) {
  const [command] = argv;
  const databaseFile = argValue('--file') ? path.resolve(argValue('--file')) : resolveDatabaseFile(process.env, { logger: console });
  const { store, reason, config } = await resolveCloudStore({ env: process.env, logger: console });

  if (command === 'status') {
    return {
      command: 'status',
      databaseFile,
      configured: Boolean(store),
      reason,
      target: config?.redacted ?? null,
      ssl: config?.ssl ?? null,
    };
  }

  if (!store) {
    const error = new Error(`CLOUD_DB_DISABLED:${reason}`);
    error.code = 'CLOUD_DB_DISABLED';
    throw error;
  }

  try {
    if (command === 'sync') {
      const result = await syncSnapshotToCloud({ databaseFile, store, logger: console, force: true });
      return { command: 'sync', databaseFile, target: config.redacted, ...result };
    }
    if (command === 'restore') {
      const result = await restoreFromCloudIfEmpty({ databaseFile, store, logger: console });
      return { command: 'restore', databaseFile, target: config.redacted, ...result };
    }
    throw Object.assign(new Error('CLOUD_DB_USAGE'), { code: 'CLOUD_DB_USAGE' });
  } finally {
    await store.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((result) => { console.log(JSON.stringify(result, null, 2)); })
    .catch((error) => {
      if (error?.code === 'CLOUD_DB_USAGE') console.error(usage());
      console.error(`CLOUD_DB_ERROR: ${error?.code ?? 'UNKNOWN'}`);
      process.exitCode = 1;
    });
}
