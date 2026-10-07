import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Database, id, now } from '../db/client.mjs';
import { createWorkerRuntime } from '../worker.mjs';

const SECRET = 'worker-leak-9f3a2b1c7d4e';
const WORKER_PATH = fileURLToPath(new URL('../worker.mjs', import.meta.url));

// Seed the minimal tenant/user/project/workspace/task graph a run needs.
function seed(db) {
  const t = now();
  const tenantId = id('tenant');
  const userId = id('user');
  const projectId = id('project');
  const workspaceId = id('workspace');
  const taskId = id('task');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'Worker Tenant', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'worker@test', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'Worker Project', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'worker goal', 'queued', t, t);
  return { tenantId, taskId };
}

test('worker runtime registers both run kinds and mirrors the server secret redaction', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-worker-'));
  const db = new Database(path.join(dir, 'worker.sqlite'));
  try {
    const { tenantId, taskId } = seed(db);
    // A code runner whose result embeds a known secret value. If the worker's
    // queue were not wired with `redact`, this value would reach `result_json`.
    const fakeRunner = async () => ({ status: 'completed', ok: true, stdout: `token=${SECRET}` });
    const fakeLLM = { status: () => [], complete: async () => ({ provider: 'test', text: '', toolCalls: [], usage: {} }) };
    const { queue } = createWorkerRuntime({ db, secrets: [SECRET], codeRunner: fakeRunner, llm: fakeLLM });

    assert.equal(typeof queue.handlers.get('code.run'), 'function', 'code.run handler must be registered');
    assert.equal(typeof queue.handlers.get('agent.run'), 'function', 'agent.run handler must be registered');
    // Server parity: the queue redactor scrubs known secret values.
    assert.equal(queue.redact({ note: SECRET }).note, '[REDACTED]');

    const run = queue.enqueue({ taskId, tenantId, kind: 'code.run', payload: { language: 'bash', source: 'echo hi' } });
    await queue.tick();
    const stored = db.get('SELECT status, result_json FROM runs WHERE id=?', run.id);
    assert.equal(stored.status, 'completed');
    assert.ok(!stored.result_json.includes(SECRET), 'result_json must NOT contain the raw secret');
    assert.ok(stored.result_json.includes('[REDACTED]'), 'result_json must carry the redaction marker');
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker process boots, starts its queue and shuts down cleanly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-worker-boot-'));
  const child = spawn(process.execPath, ['--experimental-sqlite', WORKER_PATH], {
    env: { ...process.env, NODE_ENV: 'test', DATABASE_FILE: path.join(dir, 'agent.sqlite'), WORKSPACE_ROOT: dir, WORKER_POLL_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString(); });
  child.stderr.on('data', (chunk) => { out += chunk.toString(); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker did not start in time. Output:\n${out}`)), 15000);
      const poll = setInterval(() => { if (/agent worker \S+ started/.test(out)) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 50);
      child.once('exit', (code) => { clearTimeout(timer); clearInterval(poll); reject(new Error(`worker exited early (code ${code}). Output:\n${out}`)); });
    });
    assert.match(out, /agent worker \S+ started/);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
