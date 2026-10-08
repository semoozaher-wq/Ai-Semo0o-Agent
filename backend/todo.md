# Ai-Semo0o-Agent — Four-Point Completion Plan

Scope: ONLY the four points below, on the CURRENT repo. Use existing code only —
no rebuild, no duplication, no stubs, no fake tests. Test every change, run full
tests + typecheck + security/verification. Deliver: new/modified files only + ZIP
+ DELETE LIST + final report with evidence. FORBIDDEN to modify anything outside
the four points.

## Point 1 — Unify Long-Running between server and worker
- [x] Read server.mjs + worker.mjs + long-running.mjs (confirmed divergence)
- [x] Wire createContinuationSupervisor + longRunning:true + AGENT_MAX_CONTINUATIONS into worker.mjs
- [x] Fix dead continuation branch in agent/runtime.mjs (lastStepIndex + catch-block hand-off)
- [x] Add regression test proving worker agent.run schedules a continuation
- [x] Update outdated maestro "time budget fails closed" test to the real long-running contract
- [x] Verify parity (server vs worker handler wiring) — 273 backend tests green

## Point 2 — Complete real Multi-Agent on top of EXISTING TaskGraph
- [x] Read phase2-core/platform.mjs TaskGraph/executeTaskGraph + existing tests
- [x] Implement real multi-agent orchestration ON TOP of TaskGraph (backend/agent/multi-agent.mjs)
- [x] Wire it into the agent runtime (payload.multiAgent) + scorecard comment
- [x] Add tests (roles, real tools+evidence, parallel, replan, security, turn budget, HTTP E2E) — 281 backend green

## Point 3 — Real End-to-End Agent Benchmark
- [x] Read scripts/agent-benchmark.mjs + ops/capability-benchmark.mjs
- [x] Extend benchmark to cover all 3 execution strategies E2E (single-agent, multi-agent, long-running) + code-intelligence
- [x] Add test (backend/test/agent-benchmark.e2e.test.mjs) that runs the benchmark and guards its contract
- [x] Run it and capture real evidence (agent-benchmark.report.json — all 4 scenarios 100%)

## Point 4 — Add and run real Browser E2E
- [x] Read scripts/browser-smoke.mjs + backend/browser/* (found launcher returns browser-level ws — BrowserAgent needs a page target)
- [x] Fix launcher: return a PAGE target ws + honest browserBinaryAvailable() + opt-in BROWSER_NO_SANDBOX
- [x] Add real Browser E2E (scripts/browser-e2e.mjs): BrowserAgent over CDP + runBrowserTask + browser.run tool
- [x] Add test (backend/test/browser-e2e.test.mjs) — runs real browser, skips honestly without one
- [x] Run it and capture real evidence (browser-e2e.report.json + browser-e2e.screenshot.png — 3/3 scenarios)

## Verification & Delivery
- [x] Run full test suite (all green) — 520 tests, 0 fail (legacy 80 + execution 69 + phase1 43 + frontend 22 + phase2 23 + backend 283)
- [x] Run typecheck + security scan — typecheck EXIT 0; security-scan 323 files, no findings
- [x] Extra verification — verify-imports backend 281/0 broken; boot smoke OK; capability scorecard 97/100 (12 live, 1 partial, 0 unwired); trial:self-improve 9/9
- [x] ZIP of new/modified files only
- [x] DELETE LIST
- [x] Final report (evidence + results)
