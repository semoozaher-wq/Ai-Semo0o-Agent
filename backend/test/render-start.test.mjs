import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// -----------------------------------------------------------------------------
// Regression test for the Render "Start Command" incident.
//
// Symptom (from Render logs):
//     Running 'node server.js'
//     Error: Cannot find module '/opt/render/project/src/server.js'
//
// Render uses `node server.js` as its DEFAULT start command whenever a service
// has no explicit Start Command (e.g. it was created manually instead of from
// render.yaml). This test reproduces that exact command and asserts that the
// root `server.js` compatibility shim still boots the real backend on 0.0.0.0
// and answers GET /health with 200.
// -----------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '0.0.0.0', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitForLine(stream, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for server output; saw: ${buffer}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (predicate(line)) {
          cleanup();
          resolve(line.trim());
          return;
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
    };
    stream.on('data', onData);
  });
}

test('root server.js shim boots backend/server.mjs (Render default `node server.js`)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'semo0o-render-start-'));
  const port = await getFreePort();

  // Exactly what Render runs by default, from the repository root.
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RENDER: 'true',
      PORT: String(port),
      BIND_HOST: '127.0.0.1', // must be overridden to 0.0.0.0 on Render
      SECRETS_MASTER_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
      DATABASE_FILE: path.join(tmp, 'db', 'agent.sqlite'),
      WORKSPACE_ROOT: path.join(tmp, 'workspace'),
      ALLOWED_ORIGIN: 'https://example.vercel.app',
      PUBLIC_APP_URL: 'https://example.vercel.app',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await mkdir(path.join(tmp, 'workspace'), { recursive: true });

    // 1) The shim must announce itself (proves `node server.js` found a file).
    const shimLine = await waitForLine(child.stdout, (l) => l.includes('[server.js] compatibility shim'));
    assert.ok(shimLine.includes('backend/server.mjs'), 'shim must point at backend/server.mjs');

    // 2) The real backend must boot and bind 0.0.0.0:<PORT>.
    const line = await waitForLine(child.stdout, (l) => l.includes('backend listening on'));
    assert.equal(line, `backend listening on 0.0.0.0:${port}`, 'startup log must show 0.0.0.0:PORT');

    // 3) /health must be reachable and return 200 (this is Render's health check).
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'ai-semo0o-agent-backend');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 3000);
    });
    await rm(tmp, { recursive: true, force: true });
  }
});
