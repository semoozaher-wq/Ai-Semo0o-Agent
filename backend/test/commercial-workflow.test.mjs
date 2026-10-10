import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';

// ---------------------------------------------------------------------------
// Commercial workflow E2E: request -> metered delivery -> usage/cost recorded
//                           -> monthly spend cap enforced (402, atomic).
//
// This drives the REAL HTTP server, the REAL SQLite usage tables, and the REAL
// quota/spend-limit path, using a deterministic LLM that reports token + cost
// usage so the commercial measurement chain is exercised without external spend.
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple';

function meteredLLM({ totalTokens = 120, costUsd = 0.004, text = 'مرحبا بك' } = {}) {
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete() {
      return { provider: 'test', text, toolCalls: [], usage: { promptTokens: 80, completionTokens: 40, totalTokens, costUsd } };
    },
  };
}

test('commercial workflow: metered delivery records usage/cost and enforces the spend cap atomically', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-commercial-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm: meteredLLM() });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`; // security-scan:allow private-url-literal (local loopback bind, not a hardcoded host)
  const request = async (route, options = {}) => {
    const response = await fetch(`${base}${route}`, {
      headers: { 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  try {
    const user = createUser(db, { email: 'commercial@e2e.test', password: PASSWORD, tenantName: 'Commercial' });
    const login = await request('/auth/login', { method: 'POST', body: { email: 'commercial@e2e.test', password: PASSWORD } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = login.body.session.token;

    // --- Request -> delivered reply (with metered usage) -------------------
    const chat = await request('/chat', { method: 'POST', token, body: { message: 'مرحبا' } });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));
    assert.equal(chat.body.text, 'مرحبا بك');
    assert.equal(chat.body.usage.totalTokens, 120);

    // --- Usage/cost is measured and persisted against the tenant -----------
    const usage = await request('/usage', { token });
    assert.equal(usage.status, 200, JSON.stringify(usage.body));
    assert.equal(usage.body.counter.tokens, 120);
    assert.equal(usage.body.counter.cost_usd, 0.004);
    assert.equal(usage.body.quota.monthly_cost_usd, 10);
    // `totals` aggregates the per-run `run_usage` ledger; a chat-only flow writes
    // the quota counter (authoritative for the spend cap) but no run row.
    assert.equal(typeof usage.body.totals.costUsd, 'number');

    // --- Spending limit is enforced (402) and never partially charged ------
    db.run('UPDATE usage_quotas SET monthly_cost_usd=0.004 WHERE tenant_id=?', user.tenant_id);
    const blocked = await request('/chat', { method: 'POST', token, body: { message: 'again' } });
    assert.equal(blocked.status, 402, JSON.stringify(blocked.body));
    assert.equal(blocked.body.error, 'MONTHLY_COST_QUOTA_EXCEEDED');
    const after = await request('/usage', { token });
    assert.equal(after.body.counter.cost_usd, 0.004);
    assert.equal(after.body.counter.tokens, 120);
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
