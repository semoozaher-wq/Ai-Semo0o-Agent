import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// -----------------------------------------------------------------------------
// End-to-end Render environment simulation.
//
// Reproduces the exact production failure:
//   ENV_VALIDATION_FAILED:MISSING_SECRETS_MASTER_KEY,MISSING_DATABASE_FILE,MISSING_WORKSPACE_ROOT
//
// and asserts the two halves of the contract:
//   1. With ONLY SECRETS_MASTER_KEY set (Render sets NODE_ENV=production by
//      default), the backend must boot: storage defaults fill DATABASE_FILE and
//      WORKSPACE_ROOT, the server binds 0.0.0.0:PORT and /health returns 200.
//   2. Without SECRETS_MASTER_KEY the backend must STILL fail closed — the secret
//      check is not bypassed to hide the error.
// -----------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STRONG_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

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

test('Render boot succeeds with ONLY SECRETS_MASTER_KEY (storage defaults applied)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'semo0o-render-env-'));
  const port = await getFreePort();

  // NOTE: DATABASE_FILE and WORKSPACE_ROOT are intentionally NOT set — this is
  // exactly what Render's default environment looks like.
  const child = spawn(process.execPath, ['--experimental-sqlite', 'backend/server.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: tmp, // keep any temp-dir fallback hermetic
      NODE_ENV: 'production', // Render sets this by default
      RENDER: 'true',
      PORT: String(port),
      SECRETS_MASTER_KEY: STRONG_KEY,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const line = await waitForLine(child.stdout, (l) => l.includes('backend listening on'));
    assert.equal(line, `backend listening on 0.0.0.0:${port}`, 'startup log must show 0.0.0.0:PORT');

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

test('Render boot still fails closed without SECRETS_MASTER_KEY (secret check not bypassed)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'semo0o-render-env-nosecret-'));

  const child = spawn(process.execPath, ['--experimental-sqlite', 'backend/server.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: tmp,
      NODE_ENV: 'production',
      RENDER: 'true',
      PORT: '0',
      // SECRETS_MASTER_KEY intentionally absent
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const code = await new Promise((resolve) => child.once('exit', resolve));
    assert.notEqual(code, 0, 'process must exit non-zero when the secret is missing');
    assert.match(stderr, /ENV_VALIDATION_FAILED/, 'must fail with ENV_VALIDATION_FAILED');
    assert.match(stderr, /MISSING_SECRETS_MASTER_KEY/, 'must name the missing secret');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    await rm(tmp, { recursive: true, force: true });
  }
});
