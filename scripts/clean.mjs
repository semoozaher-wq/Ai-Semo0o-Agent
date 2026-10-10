#!/usr/bin/env node
// =============================================================================
// scripts/clean.mjs
// =============================================================================
// Removes every build/cache artifact so a build is ALWAYS produced from the
// current sources. This is the first half of the "old chat UI" fix: a stale
// `dist/` or a stale Metro cache (`.expo/`, `node_modules/.cache`) is the most
// common way an outdated UI keeps being served even after the source changed.
//
// Runs automatically via the `prebuild` npm hook, so `npm run build` (and the
// Vercel build) always starts from a clean slate.
// =============================================================================

import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  'dist', // exported web build (Vercel outputDirectory)
  '.expo', // Expo/Metro local cache
  'node_modules/.cache', // Metro/Babel transform cache
];

for (const target of TARGETS) {
  rmSync(join(ROOT, target), { recursive: true, force: true });
  console.log(`· cleaned ${target}`);
}

console.log('✓ clean — build/cache artifacts removed');
