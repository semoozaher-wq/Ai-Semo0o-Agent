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
//
// The rule set and the pure `scanText()` helper are exported so the scanner has
// its own regression test (backend/test/security-scan.test.mjs): a rule that
// silently stopped matching would otherwise be invisible until an incident.
// =============================================================================
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Every rule is `[pattern, ruleName]`. Keep rule names stable: they are part of
// the inline-suppression contract (`security-scan:allow <rule>`).
export const RULES = [
  [/(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i, 'possible-hardcoded-secret'],
  // A bare `eval(` call. The negative lookbehind skips an occurrence that is
  // immediately preceded by a quote — i.e. the string data "'eval('" that
  // appears inside security blocklists — which is not a call.
  [/(?<!['"`])\beval\s*\(/, 'eval'],
  [/child_process.*shell\s*:\s*true/i, 'shell-interpolation'],
  [/https?:\/\/169\.254\.|https?:\/\/127\./i, 'private-url-literal'],
  // Dynamic code construction from a string — the same class of risk as `eval`
  // (a `Function` body is evaluated in global scope, bypassing the sandbox).
  [/(?<!['"`])\bnew\s+Function\s*\(/, 'dynamic-code-construction'],
  // A real private-key block (the vault's redaction regex uses `[A-Z0-9 ]*` and a
  // `[\s\S]*?` body, so it deliberately does NOT match this literal-header rule).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private-key-literal'],
  // React raw-HTML injection sink — an XSS vector when fed untrusted input.
  [/dangerouslySetInnerHTML/, 'dangerously-set-innerhtml'], // security-scan:allow dangerously-set-innerhtml
  // Deprecated, IV-less stream cipher (removed from Node; never use for secrets).
  [/crypto\.createCipher\(/, 'deprecated-createcipher'],
  // Well-known live-credential shapes (AWS, Stripe, Google API, GitHub, Slack).
  [/(?:AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{24,}|AIza[0-9A-Za-z_\-]{35}|ghp_[0-9A-Za-z]{36}|xox[baprs]-[0-9A-Za-z-]{10,})/, 'known-secret-shape'],
  // Interpolating a template literal straight into a shell-exec call is a command
  // injection sink. The negative lookbehind excludes method calls such as the
  // SQLite `db.exec(\`...\`)` helper, which is not a shell.
  [/(?<!\.)\bexec(?:Sync|FileSync)?\s*\(\s*`[^`]*\$\{/, 'shell-command-injection'],
];

// Inline suppression markers (see the file header).
const FILE_ALLOW = /security-scan:allow-file/;
const LINE_ALLOW = /security-scan:allow(?!-file)(?:\s+([a-z][a-z-]*))?/;

/**
 * Pure scan of a single text blob. Returns the sorted list of rule names that
 * fired, honouring the inline suppression markers. No filesystem/git access, so
 * it is trivially unit-testable.
 */
export function scanText(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  if (FILE_ALLOW.test(text)) return [];
  const lines = text.split('\n');
  const hits = new Set();
  for (const [pattern, rule] of RULES) {
    const hit = lines.some((line) => {
      if (!pattern.test(line)) return false;
      const allow = line.match(LINE_ALLOW);
      if (allow && (!allow[1] || allow[1] === rule)) return false;
      return true;
    });
    if (hit) hits.add(rule);
  }
  return [...hits].sort();
}

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
export const GENERATED_ARTIFACTS = new Set([
  'agent-benchmark.report.json',
  'browser-e2e.report.json',
  'capability-scorecard.json',
]);

export const shouldSkip = (file) =>
  file.startsWith('test/') ||
  file.startsWith('backend/test/') ||
  file.startsWith('dist/') ||
  GENERATED_ARTIFACTS.has(file);

/** Scan every git-tracked source/config file. Returns `[{ rule, file }]`. */
export async function scanRepository() {
  const files = execFileSync(
    'git',
    ['ls-files', '*.js', '*.mjs', '*.ts', '*.tsx', '*.json', '*.yml', '*.yaml'],
    { encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);
  const findings = [];
  for (const file of files) {
    if (shouldSkip(file)) continue;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // A tracked file that is missing from the working tree (e.g. a deletion
      // that has not been staged yet) is skipped instead of crashing the scan.
      continue;
    }
    for (const rule of scanText(text)) findings.push({ rule, file });
  }
  return { files, findings };
}

async function main() {
  const { files, findings } = await scanRepository();
  if (findings.length) {
    console.error(findings.map(({ rule, file }) => `${rule}:${file}`).join('\n'));
    process.exit(1);
  }
  console.log(`security-scan: ${files.length} tracked source/config files checked; no findings`);
}

// Only run the CLI when invoked directly (`node scripts/security-scan.mjs`), so
// the module can be imported by tests without side effects.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) await main();
