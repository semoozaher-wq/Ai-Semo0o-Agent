#!/usr/bin/env node
/**
 * Heuristic dead-file detector (evidence gathering only — deletes nothing).
 *
 * For every source module under backend/, src/, scripts/ and app/ it counts how
 * many OTHER files reference it by its module basename (import/export-from/
 * require/dynamic-import, or any mention of the basename). Files with zero
 * inbound references are reported as CANDIDATES for manual review; entry points
 * and files referenced only via string/runtime indirection are expected here.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.expo', '.expo-shared', 'coverage']);
const EXTS = ['.mjs', '.js', '.cjs', '.ts', '.tsx'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXTS.includes(path.extname(entry))) out.push(full);
  }
  return out;
}

const roots = ['backend', 'src', 'scripts', 'app'].map((r) => path.join(repoRoot, r));
const files = [];
for (const root of roots) {
  try { walk(root, files); } catch { /* root may not exist */ }
}
const allFiles = walk(repoRoot); // includes tests, configs, everything

// Preload every file's text once.
const texts = new Map();
for (const f of allFiles) {
  try { texts.set(f, readFileSync(f, 'utf8')); } catch { texts.set(f, ''); }
}

const candidates = [];
for (const file of files) {
  const rel = path.relative(repoRoot, file);
  // Test files, app routes and entry points are run directly, not imported.
  if (/(^|\/)test\//.test(rel) || /\.(test|spec)\./.test(rel)) continue;
  if (rel.startsWith('app/')) continue; // expo-router file-based routes
  if (/(^|\/)(server|worker)\.mjs$/.test(rel)) continue; // process entry points
  const base = path.basename(file, path.extname(file));
  // index files are re-export barrels; skip as candidates
  if (base === 'index') continue;
  let refs = 0;
  const refFiles = [];
  for (const [other, text] of texts) {
    if (other === file) continue;
    // Match the basename as a path segment (e.g. ".../foo" or "./foo'" or "/foo.mjs").
    const re = new RegExp(`[/'"\`]${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:['"\`/.]|$)`, 'g');
    if (re.test(text)) { refs += 1; refFiles.push(path.relative(repoRoot, other)); }
  }
  if (refs === 0) candidates.push({ file: rel, refs, refFiles });
}

candidates.sort((a, b) => a.file.localeCompare(b.file));
console.log(`Scanned ${files.length} source modules; ${candidates.length} with zero inbound references.\n`);
for (const c of candidates) console.log(`- ${c.file}`);
