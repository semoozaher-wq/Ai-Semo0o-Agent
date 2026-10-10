# DELETE LIST — Ai-Semo0o-Agent

Files that were **removed** because they were exact dead duplicates of a
canonical implementation. Each was verified to have **zero remaining
references** (repo-wide grep, excluding `node_modules` and `.git`).

| # | Deleted file | Reason | Canonical replacement | Refs before delete | Refs after delete |
|---|--------------|--------|-----------------------|--------------------|-------------------|
| 1 | `phase2-core/sandbox.mjs` | Duplicate of the sandbox implementation | `execution-core/sandbox.mjs` | 0 (no importers) | 0 |
| 2 | `phase2-core/code-run-tool.mjs` | Duplicate Docker code-run adapter | `execution-core/code-run-tool.mjs` | 0 (no importers) | 0 |
| 3 | `phase2-core/tavily-search.mjs` | Duplicate Tavily search client | `execution-core/tavily-search.mjs` | 0 (no importers) | 0 |

## Not deleted — converted instead of removed

| File | Action | Reason |
|------|--------|--------|
| `phase2-core/engine.mjs` | **Rewritten as a re-export shim** (`export * from '../execution-core/engine.mjs'`) | It held a stale, divergent *copy* of the execution engine (missing `#isExcludedEntry` / `changedEntries`). Rather than delete a path that could be referenced later, it now re-exports the single canonical engine. A regression test asserts the identity (`phase2Engine.AgentExecutionEngine === executionEngine.AgentExecutionEngine`). |

## Verification command used

```bash
grep -rn "phase2-core/sandbox\|phase2-core/code-run-tool\|phase2-core/tavily-search" \
  --include=*.mjs --include=*.ts --include=*.tsx --include=*.js --include=*.json . \
  | grep -v node_modules | grep -vE "\.git/"
# -> no matches (exit 1)
```

> Note: references to `execution-core/sandbox.mjs`, `execution-core/code-run-tool.mjs`
> and `execution-core/tavily-search.mjs` **still exist and are correct** — those are
> the canonical files that remain in the repository.
