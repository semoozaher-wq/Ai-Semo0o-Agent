#!/usr/bin/env node
/**
 * scripts/audit-gate.mjs — Dependency-audit release gate.
 *
 * The CI/release security gate must FAIL on a real dependency-audit failure and
 * must NOT be ignored (`continue-on-error: true` was exactly the bug this fixes).
 * But this repo also carries a small, reviewed set of advisories that are
 * accepted because they are build-time-only Expo/Metro toolchain deps with no
 * upstream patch (see scripts/audit-baseline.json and backend/audit-report.txt).
 * A blanket `npm audit` gate would therefore be permanently red and get ignored
 * again — which is the failure mode we are removing.
 *
 * This gate is honest in BOTH directions:
 *   - it PASSES while the audit contains only the reviewed, accepted advisories;
 *   - it FAILS (exit 1) the moment a NEW advisory id, a NEWLY-affected package,
 *     or a severity escalation appears — so it can never be silently ignored.
 *
 * Usage:
 *   node scripts/audit-gate.mjs [--baseline scripts/audit-baseline.json] [--audit-json <file>]
 *
 * `--audit-json` lets tests (and offline environments) feed a captured
 * `npm audit --json` report instead of hitting the registry.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const baselineFile = arg('--baseline', path.join(REPO_ROOT, 'scripts', 'audit-baseline.json'));
const auditJsonFile = arg('--audit-json', null);

// Run `npm audit --omit=dev --json`. `npm audit` exits non-zero when
// vulnerabilities exist — that is expected; its JSON report is on stdout, so we
// read stdout from the thrown error. A genuine failure (no JSON at all) is
// handled by parseReport() and fails closed.
function runAudit() {
  if (auditJsonFile) return readFileSync(auditJsonFile, 'utf8');
  try {
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error.stdout) return error.stdout;
    throw error;
  }
}

function parseReport(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    console.error('audit-gate: could not parse `npm audit --json` output (the audit did not run) — failing closed');
    process.exit(1);
  }
}

// Normalize the audit report into the two things the baseline pins: the set of
// leaf advisories (GHSA ids) and the set of affected packages with severities.
function collect(report) {
  const vulnerabilities = report.vulnerabilities ?? {};
  const advisories = [];
  const packages = [];
  for (const [name, info] of Object.entries(vulnerabilities)) {
    packages.push({ package: name, severity: info.severity });
    for (const via of info.via ?? []) {
      if (via && typeof via === 'object' && via.url) {
        const match = /GHSA-[a-z0-9-]+/i.exec(via.url);
        advisories.push({ id: match ? match[0] : via.url, package: name, severity: via.severity ?? info.severity });
      }
    }
  }
  return { advisories, packages, metadata: report.metadata ?? {} };
}

function main() {
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
  const acceptedAdvisories = new Set((baseline.acceptedAdvisories ?? []).map((advisory) => advisory.id));
  const acceptedPackages = new Map((baseline.acceptedPackages ?? []).map((pkg) => [pkg.package, pkg.severity]));

  const report = parseReport(runAudit());
  const { advisories, packages, metadata } = collect(report);
  const total = metadata.vulnerabilities?.total ?? packages.length;

  const failures = [];
  // 1. A NEW advisory id (new CVE/GHSA) is never accepted.
  for (const advisory of advisories) {
    if (!acceptedAdvisories.has(advisory.id)) failures.push(`NEW advisory ${advisory.id} (${advisory.package}, ${advisory.severity})`);
  }
  // 2. A newly-affected package, or a severity escalation on a known package, is never accepted.
  for (const pkg of packages) {
    if (!acceptedPackages.has(pkg.package)) {
      failures.push(`NEW affected package ${pkg.package} (${pkg.severity})`);
      continue;
    }
    const accepted = acceptedPackages.get(pkg.package);
    if ((SEVERITY_RANK[pkg.severity] ?? 0) > (SEVERITY_RANK[accepted] ?? 0)) failures.push(`severity escalation ${pkg.package}: ${accepted} -> ${pkg.severity}`);
  }

  if (failures.length) {
    console.error(`audit-gate: FAIL — ${failures.length} new/raised finding(s) outside the reviewed baseline:`);
    for (const line of failures) console.error(`  - ${line}`);
    console.error('audit-gate: review scripts/audit-baseline.json and either fix or explicitly accept each finding.');
    process.exit(1);
  }
  console.log(`audit-gate: PASS — ${total} advisory-affected package(s), all within the reviewed baseline (${acceptedAdvisories.size} accepted advisories, ${acceptedPackages.size} accepted packages).`);
}

main();
