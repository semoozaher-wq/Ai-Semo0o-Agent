#!/usr/bin/env node
/**
 * apply-delta.mjs — reconcile the Semo0o redesign delta with a repo checkout.
 *
 * The redesign replaced the five `app/(tabs)/*` tab routes with standalone
 * pages (`app/index.tsx`, `app/chat.tsx`, `app/agents.tsx`, `app/studio.tsx`,
 * `app/operations.tsx`). A ZIP archive can add and overwrite files but it can
 * never delete them, so applying the delta on top of the original checkout
 * leaves the old tab routes behind — which makes expo-router emit duplicate
 * routes (`/chat` AND `/(tabs)/chat`, etc.).
 *
 * This script removes exactly those obsolete files (and the now-empty
 * `app/(tabs)` directory) so the tree matches the redesigned project and the
 * web export produces the intended 17 routes instead of 22.
 *
 * Usage:
 *   node scripts/apply-delta.mjs           # apply (removes obsolete files)
 *   node scripts/apply-delta.mjs --dry-run # report only, change nothing
 *
 * It is idempotent and safe to run more than once.
 */
import { existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ lives at the project root, so the root is one level up.
const root = resolve(here, '..');
const dryRun = process.argv.includes('--dry-run');

// Files that the redesign deletes. Paths are relative to the project root.
const OBSOLETE = [
  'app/(tabs)/_layout.tsx',
  'app/(tabs)/index.tsx',
  'app/(tabs)/chat.tsx',
  'app/(tabs)/agents.tsx',
  'app/(tabs)/studio.tsx',
  'app/(tabs)/operations.tsx',
];

let removed = 0;
let missing = 0;

for (const rel of OBSOLETE) {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    missing += 1;
    console.log(`• skip (absent): ${rel}`);
    continue;
  }
  if (dryRun) {
    console.log(`• would remove: ${rel}`);
  } else {
    rmSync(abs, { force: true });
    console.log(`✓ removed: ${rel}`);
  }
  removed += 1;
}

// Remove the `app/(tabs)` directory once it is empty.
const tabsDir = join(root, 'app', '(tabs)');
if (existsSync(tabsDir) && statSync(tabsDir).isDirectory()) {
  const leftovers = readdirSync(tabsDir);
  if (leftovers.length === 0) {
    if (dryRun) {
      console.log('• would remove empty dir: app/(tabs)');
    } else {
      rmSync(tabsDir, { recursive: true, force: true });
      console.log('✓ removed empty dir: app/(tabs)');
    }
  } else {
    console.log(`• kept app/(tabs) — still holds: ${leftovers.join(', ')}`);
  }
}

console.log(
  `\n${dryRun ? '[dry-run] ' : ''}Done. removed=${removed} absent=${missing}.`,
);
if (!dryRun && removed > 0) {
  console.log('Next: npm run release:gate && npm run build');
}
