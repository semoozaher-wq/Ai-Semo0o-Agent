# Task: Deep gap analysis -> implement NEXT-LEVEL capabilities (additive, no rebuild)

The previously delivered feature set (GitHub automation, Git lifecycle, Slack/Teams/Discord/
Notion/webhook connectors, web/doc extraction, memory tools, code review, catalog/registry
wiring, multi-agent roles, TaskGraph delivery, runtime planner wiring, MemoryStore sharing,
expanded tests, ZIP) is DONE and VERIFIED. Do NOT reimplement it.

Gap analysis (broad codebase scan) -> genuinely missing, high-value, additive capabilities:

## 1. Trigger Scheduler — scheduled / recurring / one-shot autonomy  [x]
- [x] `backend/queue/scheduler.mjs`: cron (5-field) + interval + one-shot parsing, next-run math
- [x] `TriggerScheduler` tick -> creates task + enqueues run (idempotent per fire time)
- [x] `scheduled_triggers` table (schema.sql)
- [x] Server routes: GET/POST /triggers, PATCH/DELETE /triggers/:id, POST /triggers/:id/run
- [x] Wire into server + worker (start/stop)

## 2. Cross-run Reflection & Episodic Lessons  [x]
- [x] `backend/agent/reflection.mjs`: deterministic lesson extraction + store + load
- [x] `agent_reflections` table (schema.sql)
- [x] Runtime: reflect after terminal runs (fail-soft); surface lessons into planner guidance

## 3. Plugin / Extension SDK  [x]
- [x] `backend/tools/plugins.mjs`: load declarative tool packs from a directory
- [x] Registry: `register()` / `definitions()` / `openAITools()` / `view()` (merged catalog+plugins)
- [x] Runtime: plan/execute against the merged tool view (default == static catalog)
- [x] Env `TOOL_PLUGINS_DIR`; wire into server + worker

## 4. Structured Tool-Argument Validation  [x]
- [x] `backend/agent/tool-schema.mjs`: JSON-Schema-subset validator (types/enums/bounds/required)
- [x] Wire into `registry.run` (safe mode default; strict via TOOL_ARG_STRICT)

## 5. Re-entrant transactions (reliability)  [x]
- [x] `Database.transaction` uses SAVEPOINTs when nested (fixes scheduler-wraps-enqueue)
- [x] Covered by scheduler idempotency test

## 6. Tests + verify  [x]
- [x] New tests: scheduler, reflection, plugins, tool-schema (36 tests, all green)
- [x] `npm test` green (BROWSER_NO_SANDBOX=true): execution 69 / phase1 43 / frontend 30 / phase2 23 / backend 354
- [x] `npm run typecheck` green
- [x] ONE ZIP of new+modified files at original paths (38 files, no unchanged files)
