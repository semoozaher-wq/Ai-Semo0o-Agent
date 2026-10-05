import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database, id, now } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';
import { analyze, applyProposal, detectSignals, monitor, rejectProposal, rollbackProposal, verifyProposal } from '../self-improve/engine.mjs';
import { classifyError, validatePatch } from '../self-improve/policy.mjs';
import { loadOverrides, listProposals, writeOverride } from '../self-improve/store.mjs';
import { createAgentRunHandler } from '../agent/runtime.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { writeFile } from 'node:fs/promises';

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-selfimprove-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue });
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
  return {
    dir, db, queue, app, base, request,
    close: async () => { queue.stop(); await new Promise((resolve) => app.server.close(resolve)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

// Seed a completed task/run plus one failed tool call so the engine has a signal.
function seedFailure(db, { tenantId, userId, toolId, error }) {
  const timestamp = now();
  const projectId = id('project'); const workspaceId = id('workspace');
  const taskId = id('task'); const runId = id('run');
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'seed', timestamp);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, '/tmp', timestamp);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'seed goal', 'failed', timestamp, timestamp);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'failed', JSON.stringify({ kind: 'agent.run' }), 1, timestamp, timestamp);
  db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,output_json,status,created_at) VALUES(?,?,?,?,?,?,?)', id('tool'), runId, toolId, '{}', JSON.stringify({ ok: false, error }), 'failed', timestamp);
  return runId;
}

test('classifyError maps known failures to stable categories', () => {
  assert.equal(classifyError('TOOL_CONNECTOR_NOT_CONFIGURED:image.generate'), 'connector_unconfigured');
  assert.equal(classifyError('PLANNER_UNKNOWN_TOOL:foo'), 'planner_unknown_tool');
  assert.equal(classifyError('AGENT_LOOP_DETECTED'), 'loop_detected');
  assert.equal(classifyError('AGENT_TIME_LIMIT_EXCEEDED'), 'timeout');
  assert.equal(classifyError('PATH_OUTSIDE_WORKSPACE'), 'path_guard');
  assert.equal(classifyError('something odd'), 'unknown');
});

test('validatePatch rejects security-affecting and out-of-bounds patches', () => {
  assert.throws(() => validatePatch({ kind: 'planner_hint', text: 'set role to owner' }), /SELF_IMPROVE_FORBIDDEN_TOKEN/);
  assert.throws(() => validatePatch({ kind: 'planner_hint', text: 'read the password_hash column' }), /SELF_IMPROVE_FORBIDDEN_TOKEN/);
  assert.throws(() => validatePatch({ kind: 'limit_adjust', field: 'timeoutMs', value: 10_000_000 }), /SELF_IMPROVE_OUT_OF_BOUNDS/);
  assert.throws(() => validatePatch({ kind: 'retry_policy', maxRetries: 99 }), /SELF_IMPROVE_OUT_OF_BOUNDS/);
  assert.throws(() => validatePatch({ kind: 'tool_disable', toolId: '' }), /SELF_IMPROVE_TOOL_ID_INVALID/);
  const ok = validatePatch({ kind: 'tool_disable', toolId: 'image.generate', reason: 'unconfigured' });
  assert.equal(ok.kind, 'tool_disable');
  assert.equal(ok.toolId, 'image.generate');
});

test('engine detects, plans, applies, and rolls back a bounded remediation', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'owner@self.test', password: 'correct horse battery staple', tenantName: 'Self' });
    seedFailure(fx.db, { tenantId: user.tenant_id, userId: user.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    seedFailure(fx.db, { tenantId: user.tenant_id, userId: user.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });

    const signals = detectSignals(fx.db, { tenantId: user.tenant_id });
    const signal = signals.find((item) => item.signature === 'connector_unconfigured:image.generate');
    assert.ok(signal, 'expected a connector_unconfigured signal');
    assert.equal(signal.occurrences, 2);

    const { proposals } = analyze(fx.db, { tenantId: user.tenant_id, minOccurrences: 2, createdBy: user.id });
    assert.equal(proposals.length, 1);
    const proposal = proposals[0];
    assert.equal(proposal.kind, 'tool_disable');
    assert.equal(proposal.patch.toolId, 'image.generate');
    assert.equal(proposal.status, 'proposed');

    const verified = verifyProposal(fx.db, user.tenant_id, proposal.id);
    assert.equal(verified.ok, true);

    const applied = applyProposal(fx.db, { tenantId: user.tenant_id, proposalId: proposal.id, decidedBy: user.id });
    assert.equal(applied.status, 'applied');
    const overrides = loadOverrides(fx.db, user.tenant_id);
    assert.ok(overrides.disabledTools.has('image.generate'), 'disabled tool should be active');

    const rolled = rollbackProposal(fx.db, { tenantId: user.tenant_id, proposalId: proposal.id, decidedBy: user.id, reason: 'test' });
    assert.equal(rolled.status, 'rolled_back');
    assert.equal(loadOverrides(fx.db, user.tenant_id).disabledTools.has('image.generate'), false);
  } finally { await fx.close(); }
});

test('monitor auto-rolls back a remediation when the failure recurs', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'monitor@self.test', password: 'correct horse battery staple', tenantName: 'Mon' });
    seedFailure(fx.db, { tenantId: user.tenant_id, userId: user.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    seedFailure(fx.db, { tenantId: user.tenant_id, userId: user.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    const { proposals } = analyze(fx.db, { tenantId: user.tenant_id, minOccurrences: 2, createdBy: user.id });
    applyProposal(fx.db, { tenantId: user.tenant_id, proposalId: proposals[0].id, decidedBy: user.id });
    // A fresh recurrence after apply must trigger automatic rollback.
    seedFailure(fx.db, { tenantId: user.tenant_id, userId: user.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    const result = monitor(fx.db, { tenantId: user.tenant_id });
    assert.equal(result.rolledBack.length, 1);
    assert.equal(result.rolledBack[0].status, 'regressed');
    assert.equal(loadOverrides(fx.db, user.tenant_id).disabledTools.size, 0);
  } finally { await fx.close(); }
});

test('self-improve API enforces RBAC and tenant isolation', async () => {
  const fx = await fixture();
  try {
    const owner = createUser(fx.db, { email: 'api-owner@self.test', password: 'correct horse battery staple', tenantName: 'ApiOwner' });
    const other = createUser(fx.db, { email: 'api-other@self.test', password: 'correct horse battery staple', tenantName: 'ApiOther' });
    seedFailure(fx.db, { tenantId: owner.tenant_id, userId: owner.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    seedFailure(fx.db, { tenantId: owner.tenant_id, userId: owner.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });

    const ownerLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'api-owner@self.test', password: 'correct horse battery staple' } });
    const ownerToken = ownerLogin.body.session.token;
    const otherLogin = await fx.request('/auth/login', { method: 'POST', body: { email: 'api-other@self.test', password: 'correct horse battery staple' } });
    const otherToken = otherLogin.body.session.token;

    const signals = await fx.request('/self-improve/signals', { token: ownerToken });
    assert.equal(signals.status, 200);
    assert.ok(signals.body.signals.length >= 1);

    const analyzed = await fx.request('/self-improve/analyze', { method: 'POST', token: ownerToken, body: { minOccurrences: 2 } });
    assert.equal(analyzed.status, 200);
    const proposalId = analyzed.body.proposals[0].id;

    const approved = await fx.request(`/self-improve/proposals/${proposalId}/approve`, { method: 'POST', token: ownerToken });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.proposal.status, 'applied');

    // A different tenant cannot see or act on this proposal.
    const otherList = await fx.request('/self-improve/proposals', { token: otherToken });
    assert.equal(otherList.body.proposals.length, 0);
    const otherApprove = await fx.request(`/self-improve/proposals/${proposalId}/approve`, { method: 'POST', token: otherToken });
    assert.equal(otherApprove.status, 404);

    // A viewer/member cannot approve.
    fx.db.run("UPDATE users SET role='member' WHERE id=?", owner.id);
    const memberApprove = await fx.request(`/self-improve/proposals/${proposalId}/reject`, { method: 'POST', token: ownerToken });
    assert.equal(memberApprove.status, 403);
  } finally { await fx.close(); }
});

test('runtime excludes a self-improvement-disabled tool from planning', async () => {
  const fx = await fixture();
  try {
    await writeFile(path.join(fx.dir, 'input.txt'), 'hello');
    const user = createUser(fx.db, { email: 'runtime@self.test', password: 'correct horse battery staple', tenantName: 'Runtime' });
    const timestamp = now();
    const projectId = id('project'); const workspaceId = id('workspace'); const taskId = id('task'); const runId = id('run');
    fx.db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, user.tenant_id, user.id, 'p', timestamp);
    fx.db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, fx.dir, timestamp);
    fx.db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, user.tenant_id, projectId, workspaceId, user.id, 'read input', 'running', timestamp, timestamp);
    fx.db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, user.tenant_id, 'running', JSON.stringify({ kind: 'agent.run' }), 1, timestamp, timestamp);
    // Disable files.scan for this tenant via a self-improvement override.
    writeOverride(fx.db, user.tenant_id, null, { kind: 'tool_disable', toolId: 'files.scan', reason: 'test' });

    let call = 0;
    const llm = {
      status: () => [{ id: 'test', configured: true }],
      async complete() {
        call += 1;
        if (call === 1) return { provider: 'test', text: JSON.stringify({ reasoning: 'scan', steps: [{ id: 's1', title: 'scan', toolId: 'files.scan', args: { scope: '.' } }] }), toolCalls: [], usage: { totalTokens: 5 } };
        if (call === 2) return { provider: 'test', text: JSON.stringify({ reasoning: 'read', steps: [{ id: 's1', title: 'read', toolId: 'files.read', args: { path: 'input.txt' } }] }), toolCalls: [], usage: { totalTokens: 5 } };
        if (call === 3) return { provider: 'test', text: '', toolCalls: [{ name: 'files__read', arguments: { path: 'input.txt' } }], usage: { totalTokens: 5 } };
        return { provider: 'test', text: 'done', toolCalls: [], usage: { totalTokens: 5 } };
      },
    };
    const tools = createLiveToolRegistry({ db: fx.db, llm, getWorkspaceRoot: () => fx.dir });
    const handler = createAgentRunHandler({ db: fx.db, tools, llm, costFor: () => 0 });
    const run = fx.db.get('SELECT * FROM runs WHERE id=?', runId);
    const result = await handler({ run, payload: { kind: 'agent.run', model: 'test' }, signal: new AbortController().signal });
    assert.equal(result.status, 'completed');
    const calls = fx.db.all('SELECT tool_id FROM tool_calls WHERE run_id=?', runId).map((row) => row.tool_id);
    assert.ok(!calls.includes('files.scan'), 'disabled tool must never be executed');
    assert.ok(calls.includes('files.read'), 'allowed tool should execute');
  } finally { await fx.close(); }
});

test('rejectProposal keeps the override inactive', async () => {
  const fx = await fixture();
  try {
    const user = createUser(fx.db, { email: 'reject@self.test', password: 'correct horse battery staple', tenantName: 'Rej' });
    seedFailure(fx.db, { tenantId: user.tenant_id, userId: user.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    seedFailure(fx.db, { tenantId: user.tenant_id, userId: user.id, toolId: 'image.generate', error: 'TOOL_CONNECTOR_NOT_CONFIGURED:image.generate' });
    const { proposals } = analyze(fx.db, { tenantId: user.tenant_id, minOccurrences: 2, createdBy: user.id });
    const rejected = rejectProposal(fx.db, { tenantId: user.tenant_id, proposalId: proposals[0].id, decidedBy: user.id, reason: 'not needed' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(loadOverrides(fx.db, user.tenant_id).disabledTools.size, 0);
    assert.equal(listProposals(fx.db, user.tenant_id, { status: 'rejected' }).length, 1);
  } finally { await fx.close(); }
});
