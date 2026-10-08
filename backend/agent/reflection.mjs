import { id, now } from '../db/client.mjs';

// =============================================================================
// backend/agent/reflection.mjs
// -----------------------------------------------------------------------------
// Cross-run reflection & episodic lessons.
//
// The Maestro loop already records everything a run did (run_events, tool_calls,
// evidence). What it did NOT do is *learn* from it: each run started from a blank
// slate, so the same failure could recur run after run. This module closes that
// loop, additively and deterministically (no extra model call, no new execution
// path):
//
//   - after a run reaches a terminal state, `reflectOnRun` distils a small,
//     bounded set of lessons from the run's OWN events (tool failures, replans,
//     loop detection, unverified steps, delivery outcome) and persists them in
//     `agent_reflections`;
//   - `loadLessons` returns the most recent, de-duplicated lessons for a project
//     so the Context Compiler can surface them as "Learned guidance" in the
//     planner prompt of the NEXT run.
//
// Everything here is fail-soft: a reflection failure must never affect the run
// it is reflecting on.
// =============================================================================

export const REFLECTION_STATUSES = Object.freeze(['completed', 'completed_with_warnings', 'failed', 'unverified', 'blocked', 'cancelled']);
const TERMINAL = new Set(REFLECTION_STATUSES);

function parseJsonSafe(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * Distil a run's outcome into `{ status, summary, lessons: string[] }`.
 * Pure: it only reads the passed events/result, so it is trivial to unit test.
 */
export function summarizeRunOutcome({ run, result = {}, events = [] } = {}) {
  const status = result.status || run?.status || 'completed';
  const lessons = [];
  const failedTools = new Map();
  let replans = 0;
  let loopDetected = false;

  for (const event of events) {
    const type = event.type;
    const payload = parseJsonSafe(event.payload_json, {});
    if (type === 'tool_completed' && payload.ok === false && payload.toolId) {
      const message = String(payload.error || 'unknown error').slice(0, 160);
      if (!failedTools.has(payload.toolId)) failedTools.set(payload.toolId, message);
    }
    if (type === 'self_healing' && payload.action === 'replan') replans += 1;
    if (type === 'run_finished' && /LOOP_DETECTED/.test(JSON.stringify(payload))) loopDetected = true;
  }
  // The loop-detection error is surfaced through the result, not only the events.
  if (result.error && /AGENT_LOOP_DETECTED/.test(String(result.error))) loopDetected = true;

  for (const [toolId, message] of failedTools) {
    lessons.push(`Tool "${toolId}" failed previously (${message}); verify its preconditions and inputs before retrying.`);
  }
  if (replans > 0) lessons.push(`Recovery re-planning was needed ${replans} time(s); prefer a simpler, more direct plan and inspect the workspace first.`);
  if (loopDetected) lessons.push('An identical tool call was repeated; always vary arguments or gather new information instead of looping.');

  const delivery = result.delivery;
  if (delivery?.delivered) lessons.push(`Work was delivered on branch "${delivery.branch}" (${delivery.changed?.length ?? 0} file(s) changed); reuse this delivery flow.`);
  else if (delivery && delivery.reason && delivery.reason !== 'no_engine') lessons.push(`Delivery was skipped (${delivery.reason}); confirm the workspace engine and a non-default branch before delivering.`);

  if (status === 'unverified') lessons.push('A step produced output that could not be verified; add an explicit verification tool call.');

  const summary = status === 'completed'
    ? `Run completed successfully${delivery?.delivered ? ' and delivered' : ''}.`
    : `Run ended as ${status}${failedTools.size ? ` after ${failedTools.size} tool failure(s)` : ''}.`;

  return { status, summary, lessons: [...new Set(lessons)].slice(0, 8) };
}

/**
 * Persist a reflection for a terminal run. Returns the stored reflection or null
 * when the run is not terminal / there is nothing worth remembering. Never throws
 * for expected conditions.
 *
 * v3: the caller may pass the GRADED evaluation of the run (`quality` 0..100 and
 * `reward` 0..1 from `agent/evaluation.mjs`). Storing it makes the reflection the
 * durable join between the evaluation layer and the learning loop, so the loop's
 * own history can be scored and measured instead of only described in prose.
 */
export function reflectOnRun({ db, run, result = {}, events = [], quality = null, reward = null } = {}) {
  if (!db || !run) return null;
  const outcome = summarizeRunOutcome({ run, result, events });
  if (!TERMINAL.has(outcome.status)) return null;
  const projectId = run.project_id
    || db.get('SELECT project_id FROM tasks WHERE id=?', run.task_id)?.project_id
    || null;
  const reflectionId = id('refl');
  const timestamp = now();
  const qualityScore = Number.isFinite(Number(quality)) ? Number(quality) : null;
  const rewardValue = Number.isFinite(Number(reward)) ? Number(reward) : null;
  db.run(
    'INSERT INTO agent_reflections(id,tenant_id,project_id,run_id,status,summary,lessons_json,quality_score,reward,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    reflectionId, run.tenant_id, projectId, run.id, outcome.status, outcome.summary, JSON.stringify(outcome.lessons), qualityScore, rewardValue, timestamp,
  );
  return { id: reflectionId, tenantId: run.tenant_id, projectId, runId: run.id, ...outcome, qualityScore, reward: rewardValue, createdAt: timestamp };
}

/** Load the most recent, de-duplicated lessons for a project (newest first). */
export function loadLessons(db, { tenantId, projectId, limit = 5 } = {}) {
  if (!db || !tenantId) return [];
  let rows = [];
  try {
    rows = projectId
      ? db.all('SELECT lessons_json FROM agent_reflections WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC LIMIT ?', tenantId, projectId, Math.min(50, Math.max(1, limit * 4)))
      : db.all('SELECT lessons_json FROM agent_reflections WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?', tenantId, Math.min(50, Math.max(1, limit * 4)));
  } catch { return []; }
  const seen = new Set();
  const lessons = [];
  for (const row of rows) {
    for (const lesson of parseJsonSafe(row.lessons_json, [])) {
      const text = String(lesson || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      lessons.push(text);
      if (lessons.length >= limit) return lessons;
    }
  }
  return lessons;
}

export function listReflections(db, tenantId, { projectId, limit = 50 } = {}) {
  if (!db || !tenantId) return [];
  const rows = projectId
    ? db.all('SELECT * FROM agent_reflections WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC LIMIT ?', tenantId, projectId, Math.min(200, limit))
    : db.all('SELECT * FROM agent_reflections WHERE tenant_id=? ORDER BY created_at DESC LIMIT ?', tenantId, Math.min(200, limit));
  return rows.map((row) => ({
    id: row.id, tenantId: row.tenant_id, projectId: row.project_id, runId: row.run_id,
    status: row.status, summary: row.summary, lessons: parseJsonSafe(row.lessons_json, []),
    qualityScore: row.quality_score ?? null, reward: row.reward ?? null, createdAt: row.created_at,
  }));
}
