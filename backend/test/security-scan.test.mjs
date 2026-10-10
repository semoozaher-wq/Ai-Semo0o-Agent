import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import { RULES, scanText } from '../../scripts/security-scan.mjs';

/**
 * Regression guard for the SAST / secret scanner (Point 5 of the remediation).
 *
 * The scanner is the CI gate that blocks hardcoded secrets and dangerous sinks,
 * so a rule that silently stopped matching would be invisible until an incident.
 * These tests pin the *behaviour* of every rule against a representative
 * violation, prove the clean/suppression paths, and prove the scanner's own
 * source does not self-trigger.
 *
 * The scanner skips `backend/test/`, so the deliberately-bad samples below never
 * trip the real `npm run security:scan`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '../../scripts/security-scan.mjs');

// One representative violation per rule. If a rule is added, add its sample here.
const SAMPLES = Object.freeze({
  'possible-hardcoded-secret': 'const apiKey = "abcdefghijklmnopqrstuvwxyz123456";',
  eval: 'const result = eval(code);',
  'shell-interpolation': "import { exec } from 'child_process'; exec(cmd, { shell: true });",
  'private-url-literal': "fetch('http://127.0.0.1:8080/health');",
  'dynamic-code-construction': "const f = new Function('return 1');",
  'private-key-literal': 'const key = "-----BEGIN RSA PRIVATE KEY-----";',
  'dangerously-set-innerhtml': '<div dangerouslySetInnerHTML={{ __html: untrusted }} />',
  'deprecated-createcipher': "crypto.createCipher('aes192', 'password');",
  'known-secret-shape': 'const aws = "AKIAIOSFODNN7EXAMPLE";',
  'shell-command-injection': 'execSync(`rm -rf ${dir}`);',
});

test('every rule fires on its representative violation', () => {
  for (const [rule, sample] of Object.entries(SAMPLES)) {
    const hits = scanText(sample);
    assert.ok(hits.includes(rule), `rule "${rule}" failed to fire on its sample (got ${JSON.stringify(hits)})`);
  }
});

test('every rule name has a sample (no untested rules)', () => {
  const named = new Set(RULES.map(([, name]) => name));
  const sampled = new Set(Object.keys(SAMPLES));
  assert.deepEqual([...named].sort(), [...sampled].sort());
});

test('rule names are unique', () => {
  const names = RULES.map(([, name]) => name);
  assert.equal(new Set(names).size, names.length);
});

test('clean source produces no findings', () => {
  assert.deepEqual(scanText('const total = items.reduce((sum, n) => sum + n, 0);'), []);
  assert.deepEqual(scanText(''), []);
  assert.deepEqual(scanText('// a normal comment about evaluating options'), []);
});

test('inline suppressions are honoured per line, per rule and per file', () => {
  // A bare marker exempts the line from every rule.
  assert.deepEqual(scanText('eval(x); // security-scan:allow'), []);
  // A rule-scoped marker exempts only that rule.
  assert.deepEqual(scanText('eval(x); // security-scan:allow eval'), []);
  // A marker for a DIFFERENT rule must not mask this one.
  assert.ok(scanText('eval(x); // security-scan:allow private-url-literal').includes('eval'));
  // A file-level marker exempts the whole blob.
  assert.deepEqual(scanText('// security-scan:allow-file\neval(x);\nnew Function("x");'), []);
});

test('the scanner source itself is clean (rule definitions do not self-trigger)', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.deepEqual(scanText(source), [], 'the scanner must not flag its own rule definitions');
});
