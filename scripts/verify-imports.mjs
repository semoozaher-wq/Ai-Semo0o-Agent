#!/usr/bin/env node
/**
 * verify-imports.mjs
 * ---------------------------------------------------------------------------
 * Static check that every RELATIVE import/require in the project resolves to a
 * real file. This is the exact check that proves the backend's relative paths
 * (for example the security module under auth/, the queue under queue/ and the
 * code-runner under runners/) are correct, so it can be run before/after any
 * refactor.
 *
 * Usage:
 *   node scripts/verify-imports.mjs            # scan the whole repo
 *   node scripts/verify-imports.mjs backend    # scan only ./backend
 *
 * Exit code is 1 when a broken import is found (CI-friendly).
 * ---------------------------------------------------------------------------
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ? path.resolve(repoRoot, process.argv[2]) : repoRoot;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.expo', '.expo-shared', 'coverage']);
const EXTS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx'];
const RESOLVE_SUFFIXES = ['', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.json'];
const INDEX_FILES = ['index.mjs', 'index.js', 'index.cjs', 'index.ts', 'index.tsx'];

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

// Matches static import / export-from / require / dynamic-import specifiers.
const IMPORT_RE =
  /(?:import\s+(?:[^'"]*?\s+from\s+)?|export\s+[^'"]*?\s+from\s+|require\s*\(\s*|import\s*\(\s*)['"]([^'"]+)['"]/g;

function resolves(base) {
  for (const suffix of RESOLVE_SUFFIXES) {
    if (existsSync(base + suffix)) return true;
  }
  return INDEX_FILES.some((f) => existsSync(path.join(base, f)));
}

const files = walk(target);
let checked = 0;
const broken = [];
const bare = new Set();

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1];
    if (spec.startsWith('.')) {
      checked += 1;
      const base = path.resolve(path.dirname(file), spec);
      if (!resolves(base)) broken.push(`${path.relative(repoRoot, file)}  ->  ${spec}`);
    } else if (!spec.startsWith('node:') && !/^[a-z]+:/i.test(spec)) {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      bare.add(pkg);
    }
  }
}

console.log(`Scanned ${files.length} files under ${path.relative(repoRoot, target) || '.'}`);
console.log(`Relative imports checked: ${checked}`);
console.log(`Broken relative imports: ${broken.length}`);
if (broken.length) {
  console.log('\n=== BROKEN RELATIVE IMPORTS ===');
  for (const line of broken) console.log('  ' + line);
  process.exit(1);
}
console.log('All relative imports resolve to existing files. ✅');
console.log('\nBare (npm) packages referenced: ' + ([...bare].sort().join(', ') || '(none)'));
