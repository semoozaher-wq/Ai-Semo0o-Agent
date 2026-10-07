/**
 * phase2-core/changeset.mjs — Change Intelligence / ChangeSet.
 *
 * Turns raw Git output (the porcelain status entries and the unified diff that
 * `RealGit.status()` / `RealGit.diff()` already produce in execution-core) into a
 * structured, reviewable ChangeSet: per-file change records with add/delete
 * counts, an impact analysis (reusing impact.mjs), a risk assessment, and a
 * verification plan derived from what actually changed.
 *
 * It is runner-agnostic: it accepts either the objects returned by RealGit or
 * plain strings/lines, so it can be unit-tested without a real repository and
 * reused by tools, the backend runtime, and scripts.
 */

import { randomUUID } from 'node:crypto';
import { analyzeImpact, normalizePath } from './impact.mjs';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;

function unquote(value) {
  const text = String(value ?? '').trim();
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

/**
 * Parse `git status --porcelain=v1` entries into structured change records.
 * Accepts the array from `status.entries` or a raw newline-delimited string.
 */
export function parseStatusEntries(entries = []) {
  const lines = Array.isArray(entries) ? entries : String(entries ?? '').split('\n');
  const changes = [];
  for (const raw of lines) {
    const line = String(raw);
    if (!line.trim() || line.startsWith('##')) continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    let from = null;
    let target = rest;
    if (rest.includes(' -> ')) {
      const [a, b] = rest.split(' -> ');
      from = normalizePath(unquote(a));
      target = normalizePath(unquote(b));
    } else {
      target = normalizePath(unquote(rest));
    }
    if (!target) continue;

    const untracked = code === '??';
    const staged = code[0] !== ' ' && code[0] !== '?';
    const worktree = code[1] !== ' ' && code[1] !== '?';
    const marker = code.trim() || '?';

    let kind;
    if (untracked) kind = 'untracked';
    else if (marker.includes('R')) kind = 'renamed';
    else if (marker.includes('C')) kind = 'copied';
    else if (marker.includes('U')) kind = 'conflicted';
    else if (marker.includes('A')) kind = 'created';
    else if (marker.includes('D')) kind = 'deleted';
    else kind = 'modified';

    changes.push({ path: target, from, status: code, kind, staged, worktree, untracked });
  }
  return changes;
}

/** Parse a unified diff into per-file addition/deletion/hunk statistics. */
export function parseDiff(diffText = '') {
  const lines = String(diffText ?? '').split('\n');
  const files = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: match ? normalizePath(match[2]) : null, additions: 0, deletions: 0, hunks: 0, binary: false };
      files.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
      current.binary = true;
    } else if (line.startsWith('@@')) {
      current.hunks += 1;
    } else if (line.startsWith('+++') || line.startsWith('---')) {
      continue;
    } else if (line.startsWith('+')) {
      current.additions += 1;
    } else if (line.startsWith('-')) {
      current.deletions += 1;
    }
  }
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return { files, additions, deletions };
}

/** Build a verification plan from the changed file kinds and the impact result. */
export function planVerification(changes = [], impact = null) {
  const steps = [];
  const hasTs = changes.some((change) => /\.(ts|tsx)$/.test(change.path));
  const hasPackage = changes.some((change) => change.path === 'package.json');
  const affectedTests = impact?.affectedTests ?? [];

  if (hasPackage) {
    steps.push({ id: 'install', command: 'npm install', reason: 'package.json changed', required: true });
  }
  if (hasTs) {
    steps.push({ id: 'typecheck', command: 'npm run typecheck', reason: 'TypeScript sources changed', required: true });
  }
  if (affectedTests.length) {
    steps.push({ id: 'tests', command: 'npm test', reason: `${affectedTests.length} affected test file(s)`, required: true, tests: affectedTests });
  } else {
    steps.push({ id: 'tests', command: 'npm test', reason: 'no directly affected tests detected; run the full suite', required: true });
  }
  if (changes.some((change) => change.binary)) {
    steps.push({ id: 'binary-review', reason: 'binary assets changed; review manually', required: false });
  }
  return { steps, required: steps.filter((step) => step.required).map((step) => step.id), tests: affectedTests };
}

function summarize(changes, diffResult) {
  const count = (kind) => changes.filter((change) => change.kind === kind).length;
  return {
    files: changes.length,
    additions: diffResult.additions,
    deletions: diffResult.deletions,
    created: count('created'),
    modified: count('modified'),
    deleted: count('deleted'),
    renamed: count('renamed'),
    untracked: count('untracked'),
    conflicted: count('conflicted'),
  };
}

/**
 * Build a structured ChangeSet.
 *
 * @param {object} [input]
 * @param {object|string[]} [input.status]  RealGit.status() result or raw entries.
 * @param {object|string} [input.diff]      RealGit.diff() result or raw diff text.
 * @param {object} [input.intelligence]     Project index for impact analysis.
 * @param {string} [input.goal]             The goal the change set belongs to.
 */
export function buildChangeSet(input = {}) {
  const entries = Array.isArray(input.status) ? input.status : input.status?.entries ?? [];
  const statusChanges = parseStatusEntries(entries);

  const diffText = typeof input.diff === 'string' ? input.diff : input.diff?.stdout ?? '';
  const diffResult = parseDiff(diffText);
  const diffByPath = new Map(diffResult.files.map((file) => [file.path, file]));

  const changes = statusChanges.map((change) => {
    const diff = diffByPath.get(change.path) ?? { additions: 0, deletions: 0, hunks: 0, binary: false };
    return { ...change, additions: diff.additions, deletions: diff.deletions, hunks: diff.hunks, binary: diff.binary };
  });
  for (const file of diffResult.files) {
    if (!file.path || changes.some((change) => change.path === file.path)) continue;
    changes.push({
      path: file.path, from: null, status: '  ', kind: 'modified',
      staged: false, worktree: false, untracked: false,
      additions: file.additions, deletions: file.deletions, hunks: file.hunks, binary: file.binary,
    });
  }

  const changedPaths = changes.map((change) => change.path);
  const impact = input.intelligence ? analyzeImpact(input.intelligence, { changedFiles: changedPaths }) : null;
  const verification = planVerification(changes, impact);
  const risk = impact?.risk ?? { score: 0, level: 'low', factors: [] };

  return {
    id: id('changeset'),
    generatedAt: now(),
    goal: input.goal ?? null,
    summary: summarize(changes, diffResult),
    changes,
    impact,
    verification,
    risk,
  };
}

/** Short human-readable one-liner for logs / tool output. */
export function describeChangeSet(changeSet) {
  if (!changeSet) return 'no change set';
  const { summary, risk } = changeSet;
  return `${summary.files} file(s) (+${summary.additions}/-${summary.deletions}), risk ${risk.level} (${risk.score}/100)`;
}
