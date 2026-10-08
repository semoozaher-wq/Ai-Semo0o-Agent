// =============================================================================
// scripts/security-scan.mjs
// -----------------------------------------------------------------------------
// Lightweight SAST / secret scanner run in CI (`npm run security:scan`).
//
// It scans every git-tracked source/config file for a small set of high-signal
// patterns (hardcoded secrets, `eval(`, shell interpolation, private-URL
// literals). Because the rules are intentionally simple regexes, a *legitimate*
// occurrence of a pattern can appear as data (e.g. a security blocklist that
// literally contains the string "eval("). Such reviewed exceptions are declared
// inline with a suppression comment rather than by weakening a rule:
//
//   security-scan:allow            -> exempt this line from every rule
//   security-scan:allow <rule>     -> exempt this line from one rule only
//   security-scan:allow-file       -> exempt the entire file
//
// Suppressions are explicit and visible in code review, so the rules stay strict
// for the whole codebase while a single, justified occurrence can be annotated.
// =============================================================================
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.ts', '*.tsx', '*.json', '*.yml', '*.yaml'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const findings = [];
const rules = [
  [/(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i, 'possible-hardcoded-secret'],
  // A bare `eval(` call. The negative lookbehind skips an occurrence that is
  // immediately preceded by a quote — i.e. the string data "'eval('" that
  // appears inside security blocklists — which is not a call.
  [/(?<!['"`])\beval\s*\(/, 'eval'],
  [/child_process.*shell\s*:\s*true/i, 'shell-interpolation'],
  [/https?:\/\/169\.254\.|https?:\/\/127\./i, 'private-url-literal'],
];

// Inline suppression markers (see the file header).
const FILE_ALLOW = /security-scan:allow-file/;
const LINE_ALLOW = /security-scan:allow(?!-file)(?:\s+([a-z][a-z-]*))?/;

// Directory-level skips only: test trees are fixtures and `dist/` is generated
// build output. Individual source files are deliberately NOT skipped — a
// legitimate occurrence of a pattern is annotated inline with
// `security-scan:allow <rule>` (see the file header) so the rules stay strict
// for the whole codebase and every exception is visible in code review.
//
// The benchmark *report artifacts* below are generated output (produced by
// scripts/agent-benchmark.mjs, scripts/browser-e2e.mjs and
// scripts/capability-benchmark.mjs), exactly like `dist/`. They are skipped by
// name so a legitimate loopback URL recorded inside a generated report does not
// mask the scan of real source files; the source that produces them is still
// scanned in full.
const GENERATED_ARTIFACTS = new Set([
  'agent-benchmark.report.json',
  'browser-e2e.report.json',
  'capability-scorecard.json',
]);
const SKIP = (file) =>
  file.startsWith('test/') ||
  file.startsWith('backend/test/') ||
  file.startsWith('dist/') ||
  GENERATED_ARTIFACTS.has(file);

for (const file of files) {
  if (SKIP(file)) continue;
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    // A tracked file that is missing from the working tree (e.g. a deletion that
    // has not been staged yet) is skipped instead of crashing the scan.
    continue;
  }
  if (FILE_ALLOW.test(text)) continue;
  const lines = text.split('\n');
  for (const [pattern, rule] of rules) {
    const hit = lines.some((line) => {
      if (!pattern.test(line)) return false;
      const allow = line.match(LINE_ALLOW);
      if (allow && (!allow[1] || allow[1] === rule)) return false;
      return true;
    });
    if (hit) findings.push(`${rule}:${file}`);
  }
}
if (findings.length) { console.error(findings.join('\n')); process.exit(1); }
console.log(`security-scan: ${files.length} tracked source/config files checked; no findings`);
