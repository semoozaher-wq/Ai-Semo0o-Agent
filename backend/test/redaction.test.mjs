import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { redactDeep, redactString, redactSecrets, collectKnownSecrets } from '../secrets/vault.mjs';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

// A value that has NO recognisable shape: it can only be scrubbed because it is
// declared as a known secret (i.e. the two-layer redaction is exercised).
const KNOWN = 'KNOWN-SECRET-9f3a2b1c7d4e';

// Values that ARE recognisable by shape, so they must be scrubbed even when the
// caller forgets to declare them.
const SHAPES = [
  'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
];

const ALL_SECRETS = [KNOWN, ...SHAPES];

function assertNoSecrets(blob, label) {
  const text = typeof blob === 'string' ? blob : JSON.stringify(blob ?? '');
  for (const secret of ALL_SECRETS) {
    assert.ok(!text.includes(secret), `${label} leaked a secret: ${secret}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  vault.mjs unit tests                                                      */
/* -------------------------------------------------------------------------- */

test('redactString removes known values and recognisable secret shapes', () => {
  const text = `key=${KNOWN} token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;
  const clean = redactString(text, [KNOWN]);
  assert.ok(!clean.includes(KNOWN), 'known value must be removed');
  assert.ok(!clean.includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'), 'shape must be removed');
  assert.ok(clean.includes('[REDACTED]'));
});

test('redactDeep preserves structure, scrubs credential keys, keeps usage keys', () => {
  const dirty = {
    apiKey: KNOWN,
    totalTokens: 42,
    promptTokens: 7,
    nested: { note: SHAPES[0], list: [KNOWN, SHAPES[1]] },
  };
  const clean = redactDeep(dirty, [KNOWN]);
  assert.equal(clean.apiKey, '[REDACTED]');
  assert.equal(clean.totalTokens, 42, 'usage keys must never be redacted');
  assert.equal(clean.promptTokens, 7);
  assert.ok(Array.isArray(clean.nested.list));
  assertNoSecrets(clean, 'redactDeep output');
});

test('redactSecrets keeps its string contract (backwards compatible)', () => {
  const result = redactSecrets({ a: KNOWN }, [KNOWN]);
  assert.equal(typeof result, 'string');
  assert.ok(!result.includes(KNOWN));
});

test('collectKnownSecrets reads credential-shaped env vars and ignores short values', () => {
  const env = {
    OPENAI_API_KEY: 'sk-should-be-collected-123456',
    SOME_TOKEN: 'x',
    OTHER: 'not-a-secret-value',
  };
  const found = collectKnownSecrets(env);
  assert.ok(found.includes('sk-should-be-collected-123456'), 'a named key must be collected');
  assert.ok(!found.includes('x'), 'a value shorter than 6 chars must be ignored');
  assert.ok(!found.includes('not-a-secret-value'), 'a non-credential env var must be ignored');
});

/* -------------------------------------------------------------------------- */
/*  E2E: nothing persisted may contain a secret                               */
/* -------------------------------------------------------------------------- */

function scriptedLLM(planArgs) {
  let calls = 0;
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete() {
      calls += 1;
      const usage = { promptTokens: 3, completionTokens: 2, totalTokens: 5 };
      if (calls === 1) {
        return {
          provider: 'test',
          model: 'test',
          text: JSON.stringify({ reasoning: 'read', steps: [{ id: 'step_1', title: 'Read', toolId: 'files.read', args: planArgs }] }),
          toolCalls: [],
          usage,
        };
      }
      if (calls === 2) return { provider: 'test', model: 'test', text: '', toolCalls: [], usage };
      return { provider: 'test', model: 'test', text: 'done', toolCalls: [], usage };
    },
  };
}

async function withAgentApp({ llm, tools, secrets }, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-redact-'));
  const db = new Database(path.join(dir, 'redact.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm, liveTools: tools, secrets });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  try {
    const email = `redact-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
    const registered = await request('/auth/register', { method: 'POST', body: { email, password: 'correct horse battery staple', tenantName: 'Redact' } });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    const token = registered.body.session.token;
    const project = await request('/projects', { method: 'POST', token, body: { name: 'Redact Project', rootPath: dir } });
    const created = await request('/runs', { method: 'POST', token, body: { kind: 'agent.run', projectId: project.body.projectId, workspaceId: project.body.workspaceId, goal: 'Read the file', model: 'test' } });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    queue.start();
    const terminal = new Set(['completed', 'completed_with_warnings', 'failed', 'blocked', 'cancelled', 'unverified']);
    let finished = { body: { status: 'queued' } };
    for (let i = 0; i < 400; i += 1) {
      finished = await request(`/runs/${created.body.runId}`, { token });
      if (terminal.has(finished.body.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return await fn({ db, runId: created.body.runId, finished: finished.body });
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function assertRunClean(db, runId) {
  const evidence = db.all('SELECT payload_json FROM evidence WHERE run_id=?', runId);
  const toolCalls = db.all('SELECT input_json, output_json FROM tool_calls WHERE run_id=?', runId);
  const events = db.all('SELECT type, payload_json FROM run_events WHERE run_id=?', runId);
  const audits = db.all('SELECT action, metadata_json FROM audit_logs WHERE resource_id=?', runId);
  const run = db.get('SELECT result_json, checkpoint_json FROM runs WHERE id=?', runId);
  for (const row of evidence) assertNoSecrets(row.payload_json, 'evidence.payload_json');
  for (const row of toolCalls) { assertNoSecrets(row.input_json, 'tool_calls.input_json'); assertNoSecrets(row.output_json, 'tool_calls.output_json'); }
  for (const row of events) assertNoSecrets(row.payload_json, `run_events(${row.type}).payload_json`);
  for (const row of audits) assertNoSecrets(row.metadata_json, `audit_logs(${row.action}).metadata_json`);
  assertNoSecrets(run?.result_json, 'runs.result_json');
  assertNoSecrets(run?.checkpoint_json, 'runs.checkpoint_json');
  return { evidence, toolCalls, events, audits, run };
}

test('secrets in tool args and results never reach any persisted row', async () => {
  const tools = { run: async () => ({ ok: true, output: { echo: SHAPES[1], nested: { deep: SHAPES[0] } } }) };
  const planArgs = { path: 'input.txt', apiKey: KNOWN, note: SHAPES[2] };
  await withAgentApp({ llm: scriptedLLM(planArgs), tools, secrets: [KNOWN] }, async ({ db, runId, finished }) => {
    assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 500));
    const rows = assertRunClean(db, runId);
    assert.ok(rows.evidence.length >= 1, 'the run must have produced evidence');
    assert.ok(rows.toolCalls.length >= 1, 'the run must have recorded a tool call');
    // Sanity: the redaction must not have wiped the benign parts of the record.
    assert.ok(rows.toolCalls.some((row) => String(row.input_json).includes('input.txt')));
    assert.ok(rows.events.some((row) => row.type === 'tool_completed'));
  });
});

test('a secret inside a tool error is redacted before persistence', async () => {
  const tools = { run: async () => { throw new Error(`UPSTREAM_FAILED token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 key=${KNOWN}`); } };
  const planArgs = { path: 'input.txt' };
  await withAgentApp({ llm: scriptedLLM(planArgs), tools, secrets: [KNOWN] }, async ({ db, runId, finished }) => {
    assert.notEqual(finished.status, 'completed');
    const rows = assertRunClean(db, runId);
    assert.ok(rows.evidence.length >= 1);
    assert.ok(rows.toolCalls.some((row) => String(row.output_json).includes('[REDACTED]')), 'the error must be redacted, not dropped');
  });
});
