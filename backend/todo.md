# Task: Implement the last 4 review points

1. CI Security Gate (no ignore, no CI break)
2. Browser E2E Release Integration
3. Agent Benchmark Release Integration
4. Capability Scorecard Accuracy + SSRF Hardening

## 0. Baseline & architecture analysis
- [x] Baseline: full test suite 283 tests / 282 pass / 0 fail / 1 skip (EXIT=0); agent bench PASS 100%x4; browser E2E PASS 3/3; capability 91/100; security:scan FAIL (report artifact); audit:production FAIL (21 advisories)
- [x] Map call graph: ci.yml+quality.yml, release:gate (vercel), security-scan, audit, scorecard consumers (server.mjs, scripts/*), SSRF consumers (registry.mjs fetchText/browser.run)
- [x] Confirm undici NOT importable -> DNS pinning must use node:http/https `lookup`

## 1. CI Security Gate
- [x] Add scripts/audit-baseline.json (reviewed accepted advisories)
- [x] Add scripts/audit-gate.mjs (fail on NEW advisory/package/severity; pass on baseline)
- [x] Wire audit:gate into package.json + ci.yml + quality.yml; remove continue-on-error
- [x] Fix security-scan false-positive on generated report artifacts
- [ ] Verify: security:scan green, audit gate green on baseline, red on injected new advisory

## 2. Browser E2E Release Integration
- [ ] Wire existing scripts/browser-e2e.mjs into quality.yml (after browser ensured) with env
- [ ] Verify: browser E2E runs in release flow with real evidence

## 3. Agent Benchmark Release Integration
- [ ] Wire existing scripts/agent-benchmark.mjs into quality.yml
- [ ] Prove agent-loop, multi-agent, long-running, code-intelligence
- [ ] Verify: benchmark runs in release flow, non-zero on failure

## 4. Capability Scorecard Accuracy + SSRF Hardening
- [x] Scorecard: status proven vs wired; no flag-only claims; add proof input + provenScore
- [x] Feed real proof from agent benchmark + browser E2E into scorecard (scripts/capability-benchmark.mjs)
- [x] SSRF: resolveSafeUrl + pinnedLookup + pinnedRequest + safeFetchText (DNS pinning, redirect re-validation)
- [x] registry.mjs fetchText uses safeFetchText
- [x] Update capability-benchmark.test.mjs + red-team.test.mjs with real tests
- [x] Fix accuracy: passing E2E proof establishes proven even when static config flag unset (computer-use now PROVEN)

## 5. Full verification
- [x] npm test (297 tests / 296 pass / 0 fail / 1 skip, EXIT=0)
- [x] typecheck EXIT=0; security:scan EXIT=0; audit:gate PASS
- [x] agent benchmark PASS (4/4 100%); browser E2E PASS (3/3); capability benchmark 94/100 (11 proven)
- [ ] red-team + capability tests re-run after final edit
- [ ] git diff + git status review

## 6. Delivery
- [ ] Build ZIP with ONLY modified/added files at original repo paths
- [ ] Verify ZIP integrity + contents + paths
- [ ] Final reports
