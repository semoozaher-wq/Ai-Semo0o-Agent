# Task: Push Ai-Semo0o-Agent toward a General-Purpose Autonomous Agent Platform (max real features)

Reuse the EXISTING architecture (tool catalog/registry, engine, connectors, model router,
multi-agent, phase2 TaskGraph). Additive only — never rebuild or break current functionality.

## 1. GitHub automation (task -> PR -> CI -> fix)
- [x] `backend/github/service.mjs`: PRs, issues, commits, combined status, check-runs, workflow runs/jobs
- [x] Tools: github.repo, github.issues.list, github.issue.create, github.issue.comment, github.pr.create, github.ci.status

## 2. Git lifecycle tools (reuse engine.git)
- [x] `execution-core/engine.mjs`: RealGit.log()
- [x] Tools: git.status, git.diff, git.log, git.checkpoint

## 3. Integrations / connectors (extensible)
- [x] `backend/tools/connectors.mjs`: slack, teams, discord, notion, generic webhook + connectorStatus
- [x] Tools: slack.post, teams.post, discord.post, notion.page.create, webhook.post

## 4. Research / content / memory
- [x] Tools: web.extract (structured), doc.extract (docx/rtf/doc/txt), memory.search, memory.write, code.review

## 5. Orchestration wiring
- [x] `backend/agent/catalog.mjs`: register all new tools
- [x] `backend/tools/registry.mjs`: handlers + honest status gates
- [x] `backend/agent/multi-agent.mjs`: extend role tool allow-lists + delivery role
- [x] `phase2-core/platform.mjs`: optional delivery node for PR/github goals
- [x] `backend/agent/runtime.mjs`: planner guidance for connector tools
- [x] `backend/server.mjs`: share the MemoryStore with the tool registry

## 6. Tests + verify
- [x] `backend/test/expanded-capabilities.test.mjs` (catalog, status, git via fake engine, github via fetch stub, connectors via real HTTP, memory via real db, docx, SSRF)
- [x] Updated `multi-agent`, `connectors-live`, `integrations` tests for the expanded surface
- [x] `npm test` green (BROWSER_NO_SANDBOX=true required in a root container)
- [x] ONE ZIP of new+modified files at original paths (no unchanged files)
