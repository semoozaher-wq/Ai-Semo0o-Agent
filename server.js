// =============================================================================
// server.js — Render compatibility entry point (CommonJS).
// =============================================================================
// WHY THIS FILE EXISTS
// -----------------------------------------------------------------------------
// Render's DEFAULT start command for a Node web service is:
//       node server.js
// Render uses that default whenever the service has NO explicit Start Command —
// which happens when the service was created MANUALLY (Dashboard -> New ->
// Web Service) instead of from this repository's `render.yaml` Blueprint.
//
// This project's REAL entry point is `backend/server.mjs`, and it must run with
// the `--experimental-sqlite` flag, because Node's built-in SQLite
// (`node:sqlite`) is still experimental on Node 22.
//
// Without this file, Render's default command crashes at boot with:
//       Error: Cannot find module '/opt/render/project/src/server.js'
//
// With this file, even the default command boots the real backend: it simply
// re-execs `backend/server.mjs` with the correct flag.
//
// THE CANONICAL START COMMAND (set this in Render / render.yaml) IS:
//       node --experimental-sqlite backend/server.mjs
// This shim is only a safety net; it is NOT required once the Start Command
// above is applied. It never changes any application logic — it just launches
// the exact same server.
// =============================================================================
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const entry = path.join(__dirname, 'backend', 'server.mjs');

console.log(
  `[server.js] compatibility shim -> launching: node --experimental-sqlite ${entry}`,
);

const child = spawn(process.execPath, ['--experimental-sqlite', entry], {
  stdio: 'inherit', // forward stdout/stderr so Render sees "backend listening on ..."
  env: process.env, // keep Render-injected PORT, RENDER=true, secrets, etc.
});

// Forward termination signals so Render can stop the service cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* the child may already be gone */
    }
  });
}

child.on('error', (error) => {
  console.error('[server.js] failed to launch backend/server.mjs:', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
