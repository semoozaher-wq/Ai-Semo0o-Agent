/**
 * phase2-core/engine.mjs — DEPRECATED re-export shim (single source of truth).
 *
 * This file previously held a stale, divergent COPY of the execution engine.
 * A repository-wide search confirmed no module imported it, and it had drifted
 * behind the canonical implementation in `execution-core/engine.mjs` (it lacked
 * the excluded-entry filtering that delivery/checkpointing relies on:
 * `#isExcludedEntry` / `changedEntries`).
 *
 * Rather than keep two engines that can silently diverge, this path now
 * re-exports the ONE canonical engine. There is exactly one execution engine in
 * the repository; every consumer (backend, worker, task-workspace, tools) uses
 * `execution-core/engine.mjs` directly or through this shim.
 */
export * from '../execution-core/engine.mjs';
