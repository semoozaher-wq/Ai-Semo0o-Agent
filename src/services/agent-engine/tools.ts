/**
 * Tool runtime — the bridge between the LLM "brain" and the real world.
 *
 * This module is the upgraded `tools.js`. It:
 *
 *   1. Compiles the {@link TOOLS} catalog into provider-ready JSON schemas
 *      (OpenAI / Gemini / Anthropic) via the `tool-schema` compiler.
 *   2. Validates every model-supplied argument object against the tool's strict
 *      JSON schema *before* execution (the "قواعد JSON دقيقة" layer).
 *   3. Exposes a registry so real implementations (GitHub, ZIP, workspace, …)
 *      can be plugged in — unregistered integrations fail explicitly.
 *   4. Provides a {@link ToolRunner} adapter that plugs straight into the
 *      agentic `runToolLoop` / `streamToolLoop`.
 */

import { getTool, TOOLS } from '../../data/tools';
import { ToolDefinition } from '../../types/tool';
import { ToolSchema } from '../../types/model';
import { toOpenAITools, validateToolArguments } from '../ai/tool-schema';
import type { ToolRunOutcome, ToolRunner } from '../ai/tool-loop';

export interface ToolRunResult {
  toolId: string;
  ok: boolean;
  output: unknown;
  logs: string[];
  durationMs: number;
  simulated?: boolean;
  error?: string;
}

export interface ToolImplementationResult {
  output: unknown;
  simulated?: boolean;
  logs?: string[];
}

export type ToolImplementation = (
  args: Record<string, unknown>,
) => Promise<ToolImplementationResult>;

/* -------------------------------------------------------------------------- */
/*  Registry                                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Only explicitly registered integrations may execute tools.  There is no
 * fabricated/default result path: an unavailable integration must fail loudly
 * so callers cannot mistake a demo response for verified work.
 */
/** Real implementations registered at runtime, keyed by tool id. */
const REGISTERED_IMPLEMENTATIONS: Record<string, ToolImplementation> = {};

/**
 * Register (or override) a real implementation for a tool. Services such as
 * GitHub / ZIP / workspace call this on import so the LLM can drive them.
 */
export function registerTool(toolId: string, impl: ToolImplementation): void {
  REGISTERED_IMPLEMENTATIONS[toolId] = impl;
}

export function unregisterTool(toolId: string): void {
  delete REGISTERED_IMPLEMENTATIONS[toolId];
}

function resolveImplementation(toolId: string): ToolImplementation | undefined {
  return REGISTERED_IMPLEMENTATIONS[toolId];
}

export function isToolImplemented(toolId: string): boolean {
  return Boolean(resolveImplementation(toolId));
}

/** True when a production implementation is registered. */
export function isToolLive(toolId: string): boolean {
  return toolId in REGISTERED_IMPLEMENTATIONS;
}

/* -------------------------------------------------------------------------- */
/*  Schema compilation                                                         */
/* -------------------------------------------------------------------------- */

/** Compile the full tool catalog into OpenAI-style function schemas. */
export function agentToolSchemas(): ToolSchema[] {
  return toOpenAITools(TOOLS);
}

/** Compile only the requested tools (by id) into provider schemas. */
export function toolSchemasFor(toolIds: string[]): ToolSchema[] {
  const defs = toolIds
    .map((id) => getTool(id))
    .filter((d): d is ToolDefinition => Boolean(d));
  return toOpenAITools(defs);
}

export function listAgentTools(): ToolDefinition[] {
  return [...TOOLS];
}

/* -------------------------------------------------------------------------- */
/*  Execution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Run a tool by id with strict JSON-schema validation.
 *
 * Validation runs against the *compiled* schema, so enum, type, required and
 * numeric-bound rules are all enforced. Invalid input never reaches the
 * implementation — the error is returned so it can be fed back to the model.
 */
export async function runTool(
  toolId: string,
  args: Record<string, unknown> = {},
  _options: { simulateLatency?: boolean } = {},
): Promise<ToolRunResult> {
  const started = Date.now();
  const logs: string[] = [];
  const definition = getTool(toolId);

  if (!definition) {
    return {
      toolId,
      ok: false,
      output: null,
      logs,
      durationMs: Date.now() - started,
      error: `أداة غير معروفة: ${toolId}`,
    };
  }

  const impl = resolveImplementation(toolId);
  if (!impl) {
    return {
      toolId,
      ok: false,
      output: null,
      logs,
      durationMs: Date.now() - started,
      error: `لا يوجد تنفيذ للأداة: ${toolId}`,
    };
  }

  // Strict validation against the compiled JSON schema.
  const schema = toOpenAITools([definition])[0].function.parameters;
  const validation = validateToolArguments(schema, args);
  if (!validation.ok) {
    return {
      toolId,
      ok: false,
      output: { issues: validation.issues },
      logs,
      durationMs: Date.now() - started,
      error: `معطيات غير صالحة: ${validation.issues
        .map((i) => `${i.path || '<root>'} ${i.message}`)
        .join('; ')}`,
    };
  }

  try {
    const { output, logs: implLogs, simulated } = await impl(validation.value);
    logs.push(...(implLogs ?? []));
    return {
      toolId,
      ok: true,
      output,
      simulated,
      logs,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      toolId,
      ok: false,
      output: null,
      logs,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'فشل تنفيذ الأداة',
    };
  }
}

/**
 * Adapter that lets the agentic tool-calling loop drive this runtime directly.
 * Pass it as `runTool` to {@link runToolLoop} / {@link streamToolLoop}.
 */
export const toolRunner: ToolRunner = async (
  toolId: string,
  args: Record<string, unknown>,
): Promise<ToolRunOutcome> => {
  const result = await runTool(toolId, args);
  return {
    ok: result.ok,
    output: result.output,
    error: result.error,
    logs: result.logs,
    durationMs: result.durationMs,
  };
};
