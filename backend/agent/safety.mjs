// =============================================================================
// backend/agent/safety.mjs
// -----------------------------------------------------------------------------
// Production safety / recovery hardening primitives.
//
// The platform already has a permission system (`approvals`, `permissions`), a
// dangerous-tool set (`agent/catalog.mjs`) and startup validation
// (`config/env.mjs`). What was missing was a single, reusable place that:
//
//   - classifies every tool by RISK (read / write / execute / external /
//     destructive) so approval boundaries are explicit and consistent across the
//     single-agent loop and the multi-agent orchestrator;
//   - decides, uniformly, whether a tool call REQUIRES human approval before it
//     runs (destructive actions are always gated; read-only actions never are);
//   - validates startup configuration additively (reusing `validateEnv`) and
//     reports GRACEFUL DEGRADATION when providers/tools are unavailable, instead
//     of failing closed silently.
//
// It executes nothing and mutates nothing: it is pure policy + reporting, so it
// is safe to call from any layer and trivial to unit-test.
// =============================================================================

import { DANGEROUS_TOOLS } from './catalog.mjs';
import { validateEnv } from '../config/env.mjs';

export const TOOL_RISKS = Object.freeze(['read', 'write', 'execute', 'external', 'destructive']);

// Irreversible or externally-visible side effects: these are ALWAYS gated behind
// human approval, even if the catalog did not flag them as dangerous.
const DESTRUCTIVE_TOOLS = new Set([
  'git.push', 'github.pr.merge', 'github.issue.create', 'github.issue.comment',
  'email.send', 'slack.post', 'teams.post', 'discord.post', 'notion.page.create',
  'webhook.post', 'calendar.schedule',
]);

// Tools that execute untrusted code / drive a browser inside the sandbox.
const EXECUTE_TOOLS = new Set(['code.run', 'terminal.run', 'browser.run']);

// Tools that mutate the workspace or a durable store.
const WRITE_TOOLS = new Set([
  'files.write', 'files.patch', 'workspace.apply', 'git.checkpoint',
  'memory.write', 'memory.consolidate',
  'docx.create', 'docx.edit', 'odt.create', 'odt.edit', 'pptx.create', 'pptx.edit',
  'xlsx.create', 'xlsx.edit', 'speech.synthesize', 'video.generate', 'audio.generate', 'image.generate',
]);

// Tools that reach an external network service (read or write).
const EXTERNAL_TOOLS = new Set([
  'web.search', 'web.scrape', 'web.extract', 'translate', 'doc.summarize', 'code.review',
  'github.repo', 'github.issues.list', 'github.ci.status', 'github.ci.logs', 'github.pr.verify', 'github.ci.rerun',
  'image.analyze', 'media.analyze', 'speech.transcribe',
]);

/** Classify a tool's risk level. Unknown tools are treated as read-only. */
export function classifyToolRisk(toolId) {
  const id = String(toolId ?? '');
  if (DESTRUCTIVE_TOOLS.has(id)) return 'destructive';
  if (EXECUTE_TOOLS.has(id)) return 'execute';
  if (WRITE_TOOLS.has(id)) return 'write';
  if (EXTERNAL_TOOLS.has(id)) return 'external';
  return 'read';
}

/**
 * Whether a tool call requires human approval before it may run. A tool that was
 * explicitly approved for the run is never re-gated. Destructive actions and any
 * catalog-dangerous tool require approval; everything else does not.
 */
export function requiresApproval(toolId, { approvedTools } = {}) {
  const approved = approvedTools instanceof Set ? approvedTools : new Set(approvedTools ?? []);
  if (approved.has(toolId)) return false;
  if (classifyToolRisk(toolId) === 'destructive') return true;
  return DANGEROUS_TOOLS.has(toolId);
}

/**
 * Fail-closed guard: throw a machine-readable `AGENT_APPROVAL_REQUIRED` error when
 * a tool needs approval the run does not have. Callers (single-agent loop /
 * multi-agent orchestrator) use this to request approval instead of silently
 * running a destructive action.
 */
export function assertToolExecutionAllowed(toolId, { approvedTools } = {}) {
  if (!requiresApproval(toolId, { approvedTools })) return true;
  const error = new Error(`AGENT_APPROVAL_REQUIRED:${toolId}`);
  error.code = 'AGENT_APPROVAL_REQUIRED';
  error.toolId = toolId;
  error.risk = classifyToolRisk(toolId);
  throw error;
}

/** A compact, serialisable risk policy table (for /safety/status and docs). */
export function riskPolicy() {
  const risks = {};
  for (const toolId of [...DESTRUCTIVE_TOOLS, ...EXECUTE_TOOLS, ...WRITE_TOOLS, ...EXTERNAL_TOOLS]) {
    risks[toolId] = { risk: classifyToolRisk(toolId), requiresApproval: requiresApproval(toolId) };
  }
  return risks;
}

/**
 * Additive startup validation. Reuses `validateEnv` (so there is exactly one
 * definition of a fatal misconfiguration) and adds graceful-degradation
 * warnings for optional capabilities that are simply not configured.
 */
export function validateStartupConfig(env = process.env) {
  const base = validateEnv(env);
  const warnings = [...base.warnings];
  const production = env.NODE_ENV === 'production';
  // Optional capabilities: absence is a degradation, never fatal.
  if (!env.METRICS_TOKEN && production) warnings.push('METRICS_TOKEN_NOT_SET');
  if (!env.TAVILY_API_KEY && !env.SEARCH_PROVIDER) warnings.push('SEARCH_PROVIDER_NOT_CONFIGURED');
  return { ...base, warnings: [...new Set(warnings)] };
}

/**
 * Report which capabilities are degraded right now so a run can degrade
 * gracefully instead of failing opaquely. `tools` is the live registry
 * (`tools.status()`), `llm` the model router (`llm.status()`).
 */
export function degradedCapabilities({ tools = null, llm = null } = {}) {
  const providers = [];
  try {
    const status = typeof llm?.status === 'function' ? llm.status() : [];
    for (const provider of Array.isArray(status) ? status : []) providers.push({ id: provider?.id ?? 'unknown', configured: provider?.configured === true });
  } catch { /* provider status is advisory */ }
  const configuredProviders = providers.filter((provider) => provider.configured).map((provider) => provider.id);

  let toolStatus = null;
  try { toolStatus = typeof tools?.status === 'function' ? tools.status() : null; } catch { toolStatus = null; }
  const unwired = Array.isArray(toolStatus?.unwired) ? toolStatus.unwired : [];
  const failed = Array.isArray(toolStatus?.failed) ? toolStatus.failed : [];

  const unavailable = [];
  if (!configuredProviders.length) unavailable.push('llm');
  if (unwired.length) unavailable.push(`tools:${unwired.length}`);
  if (failed.length) unavailable.push(`failed_tools:${failed.length}`);

  return {
    degraded: unavailable.length > 0,
    providers,
    configuredProviders,
    unwiredTools: unwired,
    failedTools: failed,
    unavailable,
    reason: unavailable.length ? `degraded:${unavailable.join(',')}` : 'nominal',
  };
}
