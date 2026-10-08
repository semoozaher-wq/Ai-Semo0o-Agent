import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Guard for the dependency-audit release gate (scripts/audit-gate.mjs).
 *
 * The gate must PASS on the reviewed baseline and FAIL on anything new, so it can
 * never be silently ignored. These tests drive the gate with captured audit JSON
 * (offline, deterministic) — the real `npm audit` path is exercised by the CI
 * step itself.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'audit-gate.mjs');
const BASELINE = path.join(REPO_ROOT, 'scripts', 'audit-baseline.json');

function runGate(auditJsonFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--audit-json', auditJsonFile], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Build a synthetic `npm audit --json` report that exactly matches the reviewed
// baseline, so the "green" case stays in sync with the shipped baseline file.
async function baselineReport() {
  const baseline = JSON.parse(await readFile(BASELINE, 'utf8'));
  const vulnerabilities = {};
  for (const pkg of baseline.acceptedPackages) vulnerabilities[pkg.package] = { name: pkg.package, severity: pkg.severity, via: [], effects: [], range: '*', nodes: [] };
  for (const advisory of baseline.acceptedAdvisories) {
    const entry = vulnerabilities[advisory.package] ?? (vulnerabilities[advisory.package] = { name: advisory.package, severity: advisory.severity, via: [], effects: [], range: '*', nodes: [] });
    entry.via.push({ source: 1, title: advisory.id, url: `https://github.com/advisories/${advisory.id}`, severity: advisory.severity, range: '*' });
  }
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { total: baseline.acceptedPackages.length } } };
}

async function withReport(report, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-gate-test-'));
  const file = path.join(dir, 'audit.json');
  await writeFile(file, JSON.stringify(report), 'utf8');
  try {
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('audit gate: passes when the audit contains only the reviewed baseline', async () => {
  const report = await baselineReport();
  await withReport(report, async (file) => {
    const { code, stdout } = await runGate(file);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /audit-gate: PASS/);
  });
});

test('audit gate: fails on a NEW advisory id', async () => {
  const report = await baselineReport();
  report.vulnerabilities.lodash = { name: 'lodash', severity: 'critical', via: [{ source: 9, title: 'prototype pollution', url: 'https://github.com/advisories/GHSA-jf85-cpcp-j695', severity: 'critical', range: '<4.17.21' }], effects: [], range: '*', nodes: [] };
  await withReport(report, async (file) => {
    const { code, stderr } = await runGate(file);
    assert.equal(code, 1);
    assert.match(stderr, /NEW advisory GHSA-jf85-cpcp-j695/);
  });
});

test('audit gate: fails on a NEWLY-affected package', async () => {
  const report = await baselineReport();
  report.vulnerabilities.minimist = { name: 'minimist', severity: 'high', via: ['lodash'], effects: [], range: '*', nodes: [] };
  await withReport(report, async (file) => {
    const { code, stderr } = await runGate(file);
    assert.equal(code, 1);
    assert.match(stderr, /NEW affected package minimist/);
  });
});

test('audit gate: fails on a severity escalation of a known package', async () => {
  const report = await baselineReport();
  report.vulnerabilities['decode-uri-component'].severity = 'critical';
  await withReport(report, async (file) => {
    const { code, stderr } = await runGate(file);
    assert.equal(code, 1);
    assert.match(stderr, /severity escalation decode-uri-component: moderate -> critical/);
  });
});

test('audit gate: fails closed when the audit output cannot be parsed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'audit-gate-test-'));
  const file = path.join(dir, 'audit.json');
  await writeFile(file, 'npm ERR! network timeout', 'utf8');
  try {
    const { code, stderr } = await runGate(file);
    assert.equal(code, 1);
    assert.match(stderr, /failing closed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
