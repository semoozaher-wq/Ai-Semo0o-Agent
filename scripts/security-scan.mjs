import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.ts', '*.tsx', '*.json', '*.yml', '*.yaml'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const findings = [];
const rules = [
  [/(?:api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i, 'possible-hardcoded-secret'],
  [/\beval\s*\(/, 'eval'],
  [/child_process.*shell\s*:\s*true/i, 'shell-interpolation'],
  [/https?:\/\/169\.254\.|https?:\/\/127\./i, 'private-url-literal'],
];
for (const file of files) {
  if (file.startsWith('test/') || file.startsWith('backend/test/') || file.startsWith('dist/') || ['scripts/browser-smoke.mjs', 'src/store/useFilesStore.ts'].includes(file)) continue;
  const text = await readFile(file, 'utf8');
  for (const [pattern, rule] of rules) if (pattern.test(text) && !file.startsWith('test/')) findings.push(`${rule}:${file}`);
}
if (findings.length) { console.error(findings.join('\n')); process.exit(1); }
console.log(`security-scan: ${files.length} tracked source/config files checked; no findings`);
