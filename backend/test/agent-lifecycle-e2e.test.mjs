import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../db/client.mjs';
import { createApp } from '../server.mjs';
import { RunQueue } from '../queue/queue.mjs';
import { createUser } from '../auth/security.mjs';

// ---------------------------------------------------------------------------
// Full agent lifecycle E2E: Goal -> Plan -> Execute -> Test -> Repair -> Verify
//                            -> Delivery
//
// The existing suites each cover PART of the loop:
//   * agent-runtime-engine.test.mjs : Goal -> Plan -> Execute -> Test -> Verify
//     (the verification passes on the first attempt, so no repair happens)
//   * maestro-integration.test.mjs  : replan / diagnosis repair at the agent level
//   * test/execution-engine.test.mjs: engine-level replan -> verified
//
// This test closes the remaining seam by running the WHOLE loop through the real
// HTTP server, the real run queue, the real isolated task workspace and the real
// AgentExecutionEngine: the first verification command FAILS, the engine asks the
// LLM to diagnose the failure, the LLM returns a corrected operation, the edit is
// re-applied and re-tested, and only then is the run marked completed. Finally
// the verified work is DELIVERED: committed to the isolated task branch as a
// checkpoint and recorded as a delivery artifact, with the protected default
// branch left untouched.
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse battery staple';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function makeSourceRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semo0o-lifecycle-src-'));
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.email', 'src@example.invalid']);
  git(root, ['config', 'user.name', 'Source']);
  await writeFile(path.join(root, 'app.js'), 'module.exports = 1;\n', 'utf8');
  git(root, ['add', 'app.js']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

// The verification command the engine runs after every apply attempt. It only
// passes once app.js exports 3, so the first (buggy) write must fail.
const VERIFY_EXPECTS_THREE = {
  command: 'node',
  args: ['-e', "const fs=require('fs');if(fs.readFileSync('app.js','utf8').trim()!=='module.exports = 3;')process.exit(1)"],
};

// The FIRST plan writes the wrong value (2); the verification expects 3, so the
// engine's Test step fails and it must Repair before it can Verify.
const BUGGY_APPLY_ARGS = {
  operations: [{ type: 'write', path: 'app.js', content: 'module.exports = 2;\n' }],
  verification: [VERIFY_EXPECTS_THREE],
  maxAttempts: 3,
};

// The diagnosis the LLM returns once the engine reports the failed verification.
const CORRECTED_APPLY = {
  operations: [{ type: 'write', path: 'app.js', content: 'module.exports = 3;\n' }],
  verification: [VERIFY_EXPECTS_THREE],
};

function lifecycleLLM() {
  return {
    status: () => [{ id: 'test', configured: true }],
    async complete({ messages = [] } = {}) {
      const system = messages.find((message) => message.role === 'system')?.content ?? '';
      if (system.includes('secure planner')) {
        return {
          provider: 'test',
          text: JSON.stringify({ reasoning: 'edit and verify', steps: [{ id: 'step_1', title: 'Apply edit', toolId: 'workspace.apply', args: BUGGY_APPLY_ARGS }] }),
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        };
      }
      if (system.includes('Execute one planned step')) {
        return { provider: 'test', text: '', toolCalls: [{ name: 'workspace__apply', arguments: BUGGY_APPLY_ARGS }], usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
      }
      // The engine's Edit -> Test -> Diagnose/Fix -> Retest loop calls this once the
      // verification fails; the fix makes the SAME verification pass.
      if (system.includes('diagnosing a failed edit')) {
        return { provider: 'test', text: JSON.stringify(CORRECTED_APPLY), toolCalls: [], usage: { promptTokens: 8, completionTokens: 9, totalTokens: 17 } };
      }
      if (system.includes('final answer')) {
        return { provider: 'test', text: 'تم إصلاح الخطأ والتحقق بنجاح.', toolCalls: [], usage: { promptTokens: 20, completionTokens: 12, totalTokens: 32 } };
      }
      return { provider: 'test', text: JSON.stringify({ action: 'retry', args: BUGGY_APPLY_ARGS }), toolCalls: [], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
    },
  };
}

async function waitFor(check, { timeoutMs = 25_000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('WAIT_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test('full lifecycle: Goal -> Plan -> Execute -> Test -> Repair -> Verify -> Delivery through the real engine', async () => {
  const source = await makeSourceRepo();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-lifecycle-e2e-'));
  const db = new Database(path.join(dir, 'agent.sqlite'));
  const queue = new RunQueue(db, { pollMs: 5 });
  const app = createApp({ db, queue, llm: lifecycleLLM() });
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
    createUser(db, { email: 'lifecycle@e2e.test', password: PASSWORD, tenantName: 'Lifecycle' });
    const login = await request('/auth/login', { method: 'POST', body: { email: 'lifecycle@e2e.test', password: PASSWORD } });
    const token = login.body.session.token;

    // --- Goal -------------------------------------------------------------
    const projectRoot = path.join(dir, 'project-root');
    const project = await request('/projects', { method: 'POST', token, body: { name: 'P', rootPath: projectRoot } });
    assert.equal(project.status, 201, JSON.stringify(project.body));

    const created = await request('/runs', {
      method: 'POST',
      token,
      body: { kind: 'agent.run', goal: 'اجعل الاختبار يمر', projectId: project.body.projectId, workspaceId: project.body.workspaceId, model: 'test' },
    });
    assert.equal(created.status, 202, JSON.stringify(created.body));
    const { runId, taskId } = created.body;

    // --- isolated task workspace (real git clone on a task branch) --------
    const provisioned = await request(`/tasks/${taskId}/workspace`, { method: 'POST', token, body: { repo: source } });
    assert.equal(provisioned.status, 201, JSON.stringify(provisioned.body));
    const taskWorkspace = provisioned.body.workspacePath;
    const mainTip = git(taskWorkspace, ['rev-parse', 'main']);

    queue.start();

    // --- Plan -> Execute pauses on the dangerous workspace.apply ----------
    const waiting = await waitFor(async () => {
      const run = await request(`/runs/${runId}`, { token });
      return run.body.status === 'waiting_approval' ? run.body : null;
    });
    assert.ok(waiting, 'the dangerous apply must pause for human approval');

    const approved = await request(`/runs/${runId}/approval`, { method: 'POST', token, body: { decision: 'allow' } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    // --- Execute -> Test (fails) -> Repair -> Verify (passes) -------------
    const finished = await waitFor(async () => {
      const run = await request(`/runs/${runId}`, { token });
      return ['completed', 'failed', 'unverified', 'blocked'].includes(run.body.status) ? run.body : null;
    });
    assert.equal(finished.status, 'completed', JSON.stringify(finished).slice(0, 1500));

    // The repair really happened: the engine recorded a failed, rolled-back
    // attempt followed by a verified one (attempts >= 2).
    const applyEvidence = finished.evidence.find((item) => item.kind === 'tool.result' && item.payload_json.includes('workspace.apply'));
    assert.ok(applyEvidence, 'workspace.apply evidence must be recorded');
    assert.ok(applyEvidence.payload_json.includes('"state":"verified"'), 'the final apply must be verified');
    assert.ok(/"attempts":2/.test(applyEvidence.payload_json), `the engine must have repaired on the 2nd attempt: ${applyEvidence.payload_json.slice(0, 400)}`);

    // The corrected edit landed in the isolated task workspace...
    assert.equal(await readFile(path.join(taskWorkspace, 'app.js'), 'utf8'), 'module.exports = 3;\n');
    // ...and the protected default branch is untouched.
    assert.equal(git(taskWorkspace, ['rev-parse', 'main']), mainTip);
    assert.equal(git(taskWorkspace, ['branch', '--show-current']), `semo0o/task/${taskId}`);

    // The lifecycle events are all present and ordered.
    const types = finished.events.map((event) => event.type);
    assert.ok(types.includes('planning_completed'), 'Plan');
    assert.ok(types.includes('permission_requested'), 'approval gate');
    assert.ok(types.includes('step_completed'), 'Verify');
    assert.ok(finished.events.some((event) => event.type === 'tool_completed' && event.payload_json.includes('"ok":true')), 'the repaired tool call must report ok');

    // --- Delivery ---------------------------------------------------------
    // After Verify, the run must DELIVER: commit the verified change to the
    // isolated task branch as a checkpoint and record the delivery artifact.
    assert.ok(types.includes('delivery_completed'), 'the Delivery stage must be emitted');
    const delivery = finished.result?.delivery;
    assert.ok(delivery, 'the run result must include the delivery artifact');
    assert.equal(delivery.delivered, true, JSON.stringify(delivery));
    assert.equal(delivery.branch, `semo0o/task/${taskId}`);
    assert.ok(delivery.revision, 'delivery must report the commit revision');
    assert.ok(
      Array.isArray(delivery.changed) && delivery.changed.some((entry) => entry.includes('app.js')),
      `delivery must list the changed file: ${JSON.stringify(delivery.changed)}`,
    );
    assert.equal(delivery.diff.available, true);
    assert.ok(delivery.diff.stdout.includes('module.exports = 3'), 'the delivery diff must contain the verified change');

    // The checkpoint really landed on the task branch...
    assert.equal(git(taskWorkspace, ['rev-parse', 'HEAD']), delivery.revision);
    assert.match(git(taskWorkspace, ['log', '-1', '--pretty=%s']), /^semo0o: deliver/);
    // ...and the protected default branch is still untouched.
    assert.equal(git(taskWorkspace, ['rev-parse', 'main']), mainTip);

    // The delivery event carries the branch + revision and no fake state.
    const deliveryEvent = finished.events.find((event) => event.type === 'delivery_completed');
    assert.ok(deliveryEvent, 'delivery_completed event must exist');
    assert.ok(deliveryEvent.payload_json.includes(`semo0o/task/${taskId}`), deliveryEvent.payload_json);
    assert.ok(deliveryEvent.payload_json.includes('"delivered":true'), deliveryEvent.payload_json);
  } finally {
    queue.stop();
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
    await rm(dir, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  }
});
