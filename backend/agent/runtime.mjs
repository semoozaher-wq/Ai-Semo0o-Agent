import { id, now, hash } from '../db/client.mjs';
import { DANGEROUS_TOOLS, TOOL_BY_ID, fromProviderToolName, openAITools } from './catalog.mjs';
import { normalizeModelId } from '../models/catalog.mjs';
import { loadOverrides } from '../self-improve/store.mjs';

const TERMINAL = new Set(['completed', 'completed_with_warnings', 'failed', 'blocked', 'cancelled', 'unverified']);
function addUsage(a = {}, b = {}) { return { promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0), completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0), totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0) }; }
function parseJson(text) { const match = String(text || '').match(/\{[\s\S]*\}/); if (!match) throw new Error('PLANNER_INVALID_JSON'); return JSON.parse(match[0]); }
function event(db, runId, tenantId, type, details = {}) {
  const payload = { type, details, ...details, at: now() };
  db.run('INSERT INTO run_events(id,run_id,tenant_id,type,payload_json,created_at) VALUES(?,?,?,?,?,?)', id('event'), runId, tenantId, type, JSON.stringify(payload), now());
  db.run('INSERT INTO audit_logs(id,tenant_id,action,resource_type,resource_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)', id('audit'), tenantId, `agent.${type}`, 'run', runId, JSON.stringify(details), now());
}
function writeEvidence(db, run, toolId, args, result) {
  const payload = JSON.stringify({ toolId, args, result });
  const evidenceId = id('evidence');
  db.run('INSERT INTO evidence(id,run_id,kind,payload_json,sha256,created_at) VALUES(?,?,?,?,?,?)', evidenceId, run.id, 'tool.result', payload, hash(payload), now());
  db.run('INSERT INTO tool_calls(id,run_id,tool_id,input_json,output_json,status,created_at) VALUES(?,?,?,?,?,?,?)', id('tool'), run.id, toolId, JSON.stringify(args), JSON.stringify(result), result.ok === false ? 'failed' : 'completed', now());
  return evidenceId;
}
function planPrompt(goal, { allowed = [...TOOL_BY_ID.keys()], hints = [], notes = [] } = {}) {
  const guidance = [...hints, ...notes].filter(Boolean).map((line) => `- ${line}`).join('\n');
  return `You are the secure planner for an AI agent. Return ONLY JSON with this shape: {"reasoning":string,"steps":[{"id":string,"title":string,"toolId":string,"args":object}]. The toolId MUST be exactly one of: ${allowed.join(', ')}. Choose only tools that directly help. Never invent a tool name. Never choose email.send, calendar.schedule, image.generate, or image.analyze unless the user explicitly asks and the connector is available.${guidance ? `\nLearned guidance (from verified past runs):\n${guidance}` : ''} Goal:\n${goal}`;
}
function normalizePlan(raw, goal, allowed = new Set(TOOL_BY_ID.keys())) {
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length < 1 || raw.steps.length > 12) throw new Error('PLANNER_INVALID_STEP_COUNT');
  const steps = raw.steps.map((step, index) => {
    const toolId = String(step.toolId || '');
    if (!TOOL_BY_ID.has(toolId)) throw new Error(`PLANNER_UNKNOWN_TOOL:${toolId}`);
    if (!allowed.has(toolId)) throw new Error(`PLANNER_DISABLED_TOOL:${toolId}`);
    if (!step.args || typeof step.args !== 'object' || Array.isArray(step.args)) throw new Error(`PLANNER_INVALID_ARGS:${index}`);
    return { id: String(step.id || `step_${index + 1}`), title: String(step.title || toolId), toolId, args: step.args };
  });
  return { id: id('plan'), goal, reasoning: String(raw.reasoning || ''), steps };
}
function verify(result) { return result && result.ok !== false && result.output !== undefined && result.output !== null; }

export function createAgentRunHandler({ db, tools, llm, costFor = () => 0 } = {}) {
  if (!db || !tools || !llm) throw new Error('AGENT_RUNTIME_DEPENDENCIES_REQUIRED');
  return async ({ run, payload, signal }) => {
    // Hard caps are never exceeded, even when a self-improvement override asks for
    // more. Overrides may only move a limit within these caps.
    const caps = { maxSteps: 12, maxToolCalls: 48, maxRetries: 3, maxTokens: 250000, maxCostUsd: 100, timeoutMs: 30 * 60_000 };
    const limits = {
      maxSteps: Math.min(Number(payload.maxSteps || process.env.AGENT_MAX_STEPS || 12), caps.maxSteps),
      maxToolCalls: Math.min(Number(payload.maxToolCalls || process.env.AGENT_MAX_TOOL_CALLS || 24), caps.maxToolCalls),
      maxRetries: Math.min(Number(payload.maxRetries || process.env.AGENT_MAX_RETRIES || 2), caps.maxRetries),
      maxTokens: Math.min(Number(payload.maxTokens || process.env.AGENT_MAX_TOKENS || 120000), caps.maxTokens),
      maxCostUsd: Math.min(Number(payload.maxCostUsd || process.env.AGENT_MAX_COST_USD || 2), caps.maxCostUsd),
      timeoutMs: Math.min(Number(payload.timeoutMs || process.env.AGENT_TIMEOUT_MS || 10 * 60_000), caps.timeoutMs),
    };
    // Apply tenant self-improvement overrides (bounded, reversible). These can only
    // raise a limit up to its hard cap; they can never remove a cap or touch security.
    const overrides = loadOverrides(db, run.tenant_id);
    for (const [field, value] of Object.entries(overrides.limits)) {
      if (!(field in limits) || !Number.isFinite(value)) continue;
      limits[field] = Math.min(Math.max(1, value), caps[field]);
    }
    const allowedTools = new Set([...TOOL_BY_ID.keys()].filter((toolId) => !overrides.disabledTools.has(toolId)));
    if (Object.values(limits).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('AGENT_LIMITS_INVALID');
    const deadline = Date.now() + limits.timeoutMs;
    // Test doubles may use the sentinel model "test"; production routers never do.
    const model = payload.model === 'test' ? 'gpt-5-mini' : normalizeModelId(payload.model);
    const task = db.get('SELECT * FROM tasks WHERE id=?', run.task_id);
    const workspace = db.get('SELECT * FROM workspaces WHERE id=?', task?.workspace_id);
    const workspaceRoot = workspace?.root_path || process.env.WORKSPACE_ROOT;
    if (!workspaceRoot) throw new Error('WORKSPACE_ROOT_REQUIRED');
    let usage = {};
    const outputs = [];
    const seenCalls = new Set();
    let toolCalls = 0;
    const guard = () => {
      if (signal.aborted) throw new Error('AGENT_CANCELLED');
      if (Date.now() > deadline) throw new Error('AGENT_TIME_LIMIT_EXCEEDED');
      if ((usage.totalTokens || 0) > limits.maxTokens) throw new Error('AGENT_TOKEN_LIMIT_EXCEEDED');
      if (costFor(model, usage) > limits.maxCostUsd) throw new Error('AGENT_COST_LIMIT_EXCEEDED');
    };
    const approvedTools = new Set(payload.approvedTools || []);
    const resumeFrom = Number(payload.resumeFrom ?? 0);
    const emit = (type, details = {}) => event(db, run.id, run.tenant_id, type, details);
    emit('planning_started', { goal: task?.goal });
    let planner;
    let plan;
    for (let attempt = 1; attempt <= limits.maxRetries; attempt += 1) {
      guard();
      planner = await llm.complete({ model, messages: [{ role: 'system', content: planPrompt(task?.goal || payload.goal || '', { allowed: [...allowedTools], hints: overrides.plannerHints, notes: overrides.knowledgeNotes }) }, ...(attempt > 1 ? [{ role: 'user', content: 'Your previous plan was invalid. Re-plan using only the exact allowed tool IDs listed above.' }] : [])], signal });
      usage = addUsage(usage, planner.usage);
      try { plan = normalizePlan(parseJson(planner.text), task?.goal || payload.goal || '', allowedTools); break; }
      catch (error) { emit('planning_failed', { attempt, error: error.message }); if (attempt === limits.maxRetries) throw error; emit('self_healing', { action: 'replan', attempt }); }
    }
    if (plan.steps.length > limits.maxSteps) throw new Error('AGENT_STEP_LIMIT_EXCEEDED');
    db.run('UPDATE runs SET checkpoint_json=?, updated_at=? WHERE id=?', JSON.stringify({ plan, stepIndex: resumeFrom }), now(), run.id);
    emit('planning_completed', { provider: planner.provider, model: planner.model, requestedModel: planner.requestedModel, substituted: planner.substituted === true, steps: plan.steps.length, usage: planner.usage });
    const toolSchemas = openAITools();
    for (let index = resumeFrom; index < plan.steps.length; index += 1) {
      guard();
      const step = plan.steps[index];
      const tool = TOOL_BY_ID.get(step.toolId);
      emit('step_started', { stepId: step.id, title: step.title, toolId: step.toolId });
      if (DANGEROUS_TOOLS.has(step.toolId) && !approvedTools.has(step.toolId)) {
        const approvalId = id('approval');
        db.run('INSERT INTO approvals(id,run_id,requested_by,capability,decision,reason,created_at) VALUES(?,?,?,?,?,?,?)', approvalId, run.id, task.created_by, step.toolId, 'pending', `Agent requests ${step.toolId}: ${step.title}`, now());
        db.run('UPDATE runs SET checkpoint_json=?, updated_at=? WHERE id=?', JSON.stringify({ plan, stepIndex: index }), now(), run.id);
        emit('permission_requested', { stepId: step.id, toolId: step.toolId, approvalId, reason: step.title });
        return { status: 'waiting_approval', checkpoint: { plan, stepIndex: index }, usage, outputs };
      }
      let args = step.args;
      let modelTurn = await llm.complete({ model, messages: [
        { role: 'system', content: 'Execute one planned step. Use exactly one tool call when a tool is needed. Never claim a tool result you did not receive.' },
        { role: 'user', content: JSON.stringify({ goal: plan.goal, step, available: tool?.id }) },
      ], tools: toolSchemas, signal });
      usage = addUsage(usage, modelTurn.usage);
      const requested = modelTurn.toolCalls?.[0];
      if (requested && fromProviderToolName(requested.name) === step.toolId) args = requested.arguments;
      toolCalls += 1;
      if (toolCalls > limits.maxToolCalls) throw new Error('AGENT_TOOL_CALL_LIMIT_EXCEEDED');
      const fingerprint = `${step.toolId}:${JSON.stringify(args)}`;
      if (seenCalls.has(fingerprint)) throw new Error('AGENT_LOOP_DETECTED');
      seenCalls.add(fingerprint);
      // A self-improvement retry policy may raise retries for a specific tool, but
      // never beyond the hard ceiling of 5.
      const toolRetries = Math.min(Number(overrides.retryPolicy[step.toolId] ?? overrides.retryPolicy['*'] ?? limits.maxRetries), 5);
      let toolResult;
      let evidenceId;
      for (let attempt = 1; attempt <= toolRetries; attempt += 1) {
        guard();
        try { toolResult = await tools.run(step.toolId, args, { run, task, workspaceRoot, model: payload.model, signal, llm }); }
        catch (error) { toolResult = { ok: false, output: null, error: error instanceof Error ? error.message : String(error) }; }
        evidenceId = writeEvidence(db, run, step.toolId, args, toolResult);
        outputs.push({ stepId: step.id, toolId: step.toolId, attempt, result: toolResult, evidenceId });
        emit('tool_completed', { stepId: step.id, toolId: step.toolId, ok: toolResult.ok !== false, output: toolResult.output, error: toolResult.error, evidenceId, attempt });
        if (toolResult.ok !== false) break;
        if (attempt === toolRetries) throw new Error(toolResult.error || `TOOL_FAILED:${step.toolId}`);
        const diagnosis = await llm.complete({ model, messages: [
          { role: 'system', content: 'Diagnose the failed tool call. Return ONLY JSON: {"action":"retry","args":object}. Never change security, authentication, policy, or permissions.' },
          { role: 'user', content: JSON.stringify({ tool: step.toolId, args, error: toolResult.error }) },
        ], signal });
        usage = addUsage(usage, diagnosis.usage);
        try {
          const repair = parseJson(diagnosis.text);
          if (repair.action !== 'retry' || !repair.args || typeof repair.args !== 'object') throw new Error('REPAIR_NOT_ALLOWED');
          args = repair.args;
          emit('self_healing', { stepId: step.id, toolId: step.toolId, action: 'repair', attempt });
        } catch (error) { throw new Error(`SELF_HEALING_FAILED:${error.message}`); }
      }
      const verification = verify(toolResult) ? { status: 'VERIFIED', evidenceId } : { status: 'UNVERIFIED', evidenceId };
      db.run('INSERT INTO evidence(id,run_id,kind,payload_json,sha256,created_at) VALUES(?,?,?,?,?,?)', id('evidence'), run.id, 'verification', JSON.stringify(verification), hash(JSON.stringify(verification)), now());
      emit('step_completed', { stepId: step.id, toolId: step.toolId, verification: verification.status, evidenceId });
      if (verification.status !== 'VERIFIED') return { status: 'unverified', outputs, usage };
    }
    guard();
    const final = await llm.complete({ model, messages: [
      { role: 'system', content: 'Return a concise final answer in Arabic when appropriate. Mention evidence and any limitations. Do not invent.' },
      { role: 'user', content: JSON.stringify({ goal: plan.goal, outputs }) },
    ], signal });
    usage = addUsage(usage, final.usage);
    const costUsd = costFor(model, usage);
    db.run('INSERT INTO run_usage(id,run_id,tenant_id,provider,model,prompt_tokens,completion_tokens,total_tokens,cost_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id('usage'), run.id, run.tenant_id, final.provider || planner.provider, model, usage.promptTokens || 0, usage.completionTokens || 0, usage.totalTokens || 0, costUsd, now());
    emit('run_finished', { status: 'completed', usage, costUsd, final: final.text });
    return { status: 'completed', final: final.text, plan, outputs, usage, costUsd };
  };
}
