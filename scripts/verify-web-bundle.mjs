#!/usr/bin/env node
// =============================================================================
// scripts/verify-web-bundle.mjs
// =============================================================================
// Guards against the "old chat UI" regression.
//
// WHY THIS EXISTS
// -----------------------------------------------------------------------------
// The chat surface is `src/screens/Chat.tsx` (the "v2" UI: desktop conversation
// rail + shared `ConversationsList`, the `Composer`, the model-picker `Sheet`,
// and the responsive layout). Historically a STALE build / cached bundle kept
// rendering the pre-rail chat even though the source was already updated. That
// is a *shipping* failure, not a source failure, and it is invisible in code
// review — so we assert it at build time instead.
//
// WHAT IT CHECKS
// -----------------------------------------------------------------------------
//   1. The exported web bundle exists (`dist/_expo/static/js/web/*.js`).
//   2. It contains the stable sentinel exported by `src/screens/Chat.tsx`
//      (`CHAT_UI_BUNDLE_SENTINEL`), which only the v2 chat surface renders.
//   3. It contains the v2-only conversation-list copy
//      ("… ابدأ محادثة جديدة لتظهر هنا.") which the pre-rail chat never had.
//
// If any check fails the process exits non-zero, which fails `npm run build`
// (and therefore the Vercel build), so an old/stale chat bundle can never be
// deployed silently. This is a fail-closed gate by design.
//
// USAGE
//   npm run verify:web        # after `npm run export:web`
// =============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIR = join(ROOT, 'dist', '_expo', 'static', 'js', 'web');

/** The stable token exported by src/screens/Chat.tsx. */
const CHAT_UI_SENTINEL = 'semo0o-chat-ui-v2-rail-composer';

/**
 * A copy string that exists ONLY in the v2 chat surface (the shared
 * `ConversationsList` empty state). The pre-rail chat used the shorter
 * "لا توجد محادثات محفوظة بعد." without the second sentence.
 */
const V2_ONLY_COPY = 'ابدأ محادثة جديدة لتظهر هنا';

/** Escape a string the way Metro/terser emits non-ASCII string literals. */
function escapeForBundle(value) {
  let out = '';
  for (const ch of value) {
    out += ch.codePointAt(0) > 127 ? `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}

function fail(message) {
  console.error(`\n✗ verify:web — ${message}\n`);
  process.exit(1);
}

if (!existsSync(BUNDLE_DIR)) {
  fail(
    `no web bundle found at dist/_expo/static/js/web — run "npm run export:web" first ` +
      `(or "npm run build", which runs it for you).`,
  );
}

const bundles = readdirSync(BUNDLE_DIR).filter((name) => name.endsWith('.js'));
if (bundles.length === 0) {
  fail(`dist/_expo/static/js/web contains no .js bundle.`);
}

const haystack = bundles.map((name) => readFileSync(join(BUNDLE_DIR, name), 'utf8')).join('\n');

const checks = [
  { label: `chat-UI sentinel (${CHAT_UI_SENTINEL})`, needle: CHAT_UI_SENTINEL },
  { label: `v2-only conversation copy`, needle: escapeForBundle(V2_ONLY_COPY) },
];

let ok = true;
for (const { label, needle } of checks) {
  if (haystack.includes(needle)) {
    console.log(`✓ ${label}`);
  } else {
    ok = false;
    console.error(`✗ ${label} — NOT found in the exported bundle`);
  }
}

if (!ok) {
  fail(
    `the exported web bundle does not contain the current chat UI. ` +
      `This means the build is STALE or built from the wrong sources — do NOT deploy it. ` +
      `Clear caches ("npm run clean") and rebuild.`,
  );
}

console.log(`\n✓ verify:web — chat UI v2 confirmed in ${bundles.length} bundle(s).\n`);
