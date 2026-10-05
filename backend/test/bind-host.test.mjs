import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveBindHost } from '../config/bind.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- Unit tests: host resolution -------------------------------------------------

test('resolveBindHost FORCES 0.0.0.0 on Render even if BIND_HOST is loopback', () => {
  assert.equal(resolveBindHost({ RENDER: 'true', PORT: '10000', BIND_HOST: '127.0.0.1' }), '0.0.0.0');
  assert.equal(resolveBindHost({ RENDER_SERVICE_ID: 'srv-123', BIND_HOST: 'localhost' }), '0.0.0.0');
  assert.equal(resolveBindHost({ RENDER_EXTERNAL_URL: 'https://x.onrender.com' }), '0.0.0.0');
});

test('resolveBindHost binds 0.0.0.0 whenever PORT is present', () => {
  assert.equal(resolveBindHost({ PORT: '10000' }), '0.0.0.0');
});

test('resolveBindHost keeps loopback for a plain local run and honours BIND_HOST', () => {
  assert.equal(resolveBindHost({}), '127.0.0.1');
  assert.equal(resolveBindHost({ BIND_HOST: '0.0.0.0' }), '0.0.0.0');
});

// --- Live test: the real server must bind 0.0.0.0 and answer /health ------------

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

function waitForLine(stream, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for server output; saw: ${buffer}`)); }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (predicate(line)) { cleanup(); resolve(line.trim()); return; }
      }
    };
    const cleanup = () => { clearTimeout(timer); stream.off('data', onData); };
    stream.on('data', onData);
  });
}

test('server boots on a dynamic PORT, binds 0.0.0.0 and /health returns 200 (Render simulation)', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'semo0o-bind-'));
  const port = await getFreePort();
  const child = spawn(process.execPath, ['--experimental-sqlite', 'backend/server.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      RENDER: 'true',
      PORT: String(port),
      BIND_HOST: '127.0.0.1', // must be overridden by the forced 0.0.0.0 on Render
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
    const line = await waitForLine(child.stdout, (l) => l.includes('backend listening on'));
    assert.equal(line, `backend listening on 0.0.0.0:${port}`, 'startup log must show 0.0.0.0:PORT');

    // Reachable on the wildcard address (this is what Render's port-scanner does).
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'ai-semo0o-agent-backend');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
    await rm(tmp, { recursive: true, force: true });
  }
});
