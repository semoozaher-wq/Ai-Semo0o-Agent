// =============================================================================
// backend/memory/consolidate.mjs
// -----------------------------------------------------------------------------
// Memory consolidation & cross-run learning.
//
// `agent/reflection.mjs` already distils per-run lessons into `agent_reflections`.
// What was missing is turning that episodic stream into REUSABLE project
// knowledge: right now a lesson only helps if the Context Compiler re-reads the
// last few reflections. This module closes the loop, additively:
//
//   - `consolidateProjectMemory` reads a project's recent reflections, groups
//     their lessons by a stable SIGNATURE (so the same lesson seen across many
//     runs is counted, not duplicated), keeps the ones that recur (or that are
//     intrinsically high-value), and writes them as a single, de-duplicated
//     knowledge document into project memory via `MemoryStore.upsertDocument`.
//   - Because it upserts by `source`, re-running consolidation refreshes the one
//     consolidated doc instead of piling up copies, and the doc becomes
//     retrievable by `memory.search` (and therefore by the planner prompt).
//
// Everything is fail-soft and bounded: a consolidation failure never affects a
// run, and the output document is size-capped.
// =============================================================================

import { loadLessons } from '../agent/reflection.mjs';

export const CONSOLIDATED_SOURCE = 'consolidated:lessons';
const MAX_DOC_CHARS = 20_000;
const DEFAULT_MIN_OCCURRENCES = 2;

function parseJsonSafe(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

/**
 * Normalize a lesson into a stable signature so semantically-identical lessons
 * from different runs collapse together. Quotes/ids/numbers are stripped so the
 * same class of lesson always maps to the same key.
 */
export function lessonSignature(lesson) {
  return String(lesson ?? '')
    .toLowerCase()
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+\b/g, '#')
    .replace(/[^a-z\u0600-\u06ff#…]+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Lessons that are worth keeping even when seen only once. */
const HIGH_VALUE = [/deliver/i, /pull request|\bpr\b/i, /verif/i, /secret|credential|token/i, /protected branch|default branch/i];

function isHighValue(lesson) {
  return HIGH_VALUE.some((pattern) => pattern.test(lesson));
}

/**
 * Consolidate a project's reflections into one reusable knowledge document.
 *
 * @param {object}   deps
 * @param {object}   deps.db            Database (reads `agent_reflections`).
 * @param {object}   deps.memory        MemoryStore (writes the consolidated doc).
 * @param {string}   deps.tenantId
 * @param {string}   deps.projectId
 * @param {object}  [options]
 * @param {number}  [options.lookback]        Max reflections to scan (default 100).
 * @param {number}  [options.minOccurrences]  Recurrence threshold (default 2).
 * @param {boolean} [options.dryRun]          Compute but do not write.
 * @returns {Promise<{ reflections, lessons, recurring, kept, written, updated, source, documentId }>}
 */
export async function consolidateProjectMemory({ db, memory, tenantId, projectId, lookback = 100, minOccurrences = DEFAULT_MIN_OCCURRENCES, dryRun = false } = {}) {
  if (!db || !tenantId || !projectId) throw new Error('CONSOLIDATION_CONTEXT_REQUIRED');
  const reflections = db.all(
    'SELECT lessons_json FROM agent_reflections WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC LIMIT ?',
    tenantId, projectId, Math.max(1, Math.min(500, Number(lookback) || 100)),
  );

  // Count each distinct lesson by signature across every reflection.
  const groups = new Map();
  let totalLessons = 0;
  for (const row of reflections) {
    for (const lesson of parseJsonSafe(row.lessons_json, [])) {
      const text = String(lesson || '').trim();
      if (!text) continue;
      totalLessons += 1;
      const signature = lessonSignature(text);
      if (!signature) continue;
      const entry = groups.get(signature) ?? { signature, text, count: 0 };
      entry.count += 1;
      groups.set(signature, entry);
    }
  }

  const threshold = Math.max(1, Number(minOccurrences) || DEFAULT_MIN_OCCURRENCES);
  const kept = [...groups.values()]
    .filter((entry) => entry.count >= threshold || isHighValue(entry.text))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));

  const recurring = kept.filter((entry) => entry.count >= threshold).length;
  const body = kept.length
    ? [
      '# Consolidated lessons (auto-generated)',
      '',
      `Derived from ${reflections.length} reflection(s) / ${totalLessons} raw lesson(s).`,
      'Apply these when planning; they are distilled from this project\'s own past runs.',
      '',
      ...kept.map((entry) => `- ${entry.text}${entry.count > 1 ? ` (seen ${entry.count}×)` : ''}`),
    ].join('\n').slice(0, MAX_DOC_CHARS)
    : '';

  if (dryRun || !kept.length) {
    return { reflections: reflections.length, lessons: totalLessons, recurring, kept: kept.length, written: false, updated: false, source: CONSOLIDATED_SOURCE, documentId: null, content: body };
  }
  if (!memory || typeof memory.upsertDocument !== 'function') throw new Error('MEMORY_UNAVAILABLE');

  const document = await memory.upsertDocument({ tenantId, projectId, source: CONSOLIDATED_SOURCE, content: body });
  return { reflections: reflections.length, lessons: totalLessons, recurring, kept: kept.length, written: true, updated: Boolean(document.updated), source: CONSOLIDATED_SOURCE, documentId: document.id };
}

/**
 * Convenience: the lessons the planner should see, merging the live per-run
 * lessons with the consolidated knowledge doc (which is retrieved from memory).
 * Bounded and de-duplicated. Fail-soft.
 */
export async function loadConsolidatedLessons({ db, memory, tenantId, projectId, limit = 8 } = {}) {
  const live = (() => { try { return loadLessons(db, { tenantId, projectId, limit }); } catch { return []; } })();
  let consolidated = [];
  try {
    if (memory && typeof memory.search === 'function') {
      const hits = await memory.search({ tenantId, projectId, query: 'consolidated lessons guidance', limit: 3 });
      const doc = hits.find((hit) => hit.source === CONSOLIDATED_SOURCE);
      if (doc) consolidated = String(doc.content).split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2).trim());
    }
  } catch { /* memory is advisory */ }
  const seen = new Set();
  const merged = [];
  for (const lesson of [...consolidated, ...live]) {
    const text = String(lesson || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    merged.push(text);
    if (merged.length >= limit) break;
  }
  return merged;
}
