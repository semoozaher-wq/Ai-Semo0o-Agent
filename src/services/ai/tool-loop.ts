/**
 * Agentic tool-calling loop.
 *
 * This is the beating heart of the "real brain": it repeatedly asks the model
 * for the next action, executes any requested tools, feeds the results back as
 * `role: 'tool'` messages, and continues until the model produces a final
 * answer (or the step budget is exhausted).
 *
 * It is transport-agnostic: pass any {@link LLMProvider} and any
 * {@link ToolRunner}, so the same loop powers chat, the autonomous agent
 * engine, and background jobs.
 */

import {
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResult,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from '../../types/model';
import { parseAndValidateToolArguments } from './tool-schema';
import { LLMProvider } from './provider';

export interface ToolRunOutcome {
  ok: boolean;
  output: unknown;
  error?: string | undefined;
  logs?: string[] | undefined;
  durationMs: number;
}

export type ToolRunner = (
  toolId: string,
  args: Record<string, unknown>,
) => Promise<ToolRunOutcome>;

export interface ToolLoopEvent {
  type: 'assistant' | 'delta' | 'tool_call' | 'tool_result' | 'final' | 'error';
  /** Assistant text (for `assistant`/`final`). */
  content?: string;
  /** Streaming text fragment (for `delta`). */
  delta?: string;
  toolCall?: ToolCall;
  toolResult?: ToolRunOutcome & { toolId: string; args: Record<string, unknown> };
  step?: number;
  error?: string;
}

export interface ToolLoopOptions {
  provider: LLMProvider;
  toolSchemas: ToolSchema[];
  runTool: ToolRunner;
  maxSteps?: number;
  temperature?: number;
  maxTokens?: number;
  toolChoice?: ChatCompletionRequest['toolChoice'];
  signal?: AbortSignal;
  onEvent?: (event: ToolLoopEvent) => void;
}

export interface ToolLoopResult {
  content: string;
  messages: ChatCompletionMessage[];
  usage: TokenUsage;
  steps: number;
  stopped: 'final' | 'max_steps';
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

function schemaByName(toolSchemas: ToolSchema[]): Map<string, ToolSchema> {
  const map = new Map<string, ToolSchema>();
  for (const schema of toolSchemas) map.set(schema.function.name, schema);
  return map;
}

async function executeToolCall(
  call: ToolCall,
  schemas: Map<string, ToolSchema>,
  runTool: ToolRunner,
): Promise<{ message: ChatCompletionMessage; outcome: ToolRunOutcome }> {
  const schema = schemas.get(call.function.name);
  const started = Date.now();

  if (!schema) {
    const outcome: ToolRunOutcome = {
      ok: false,
      output: null,
      error: `unknown tool: ${call.function.name}`,
      durationMs: Date.now() - started,
    };
    return {
      outcome,
      message: {
        role: 'tool',
        toolCallId: call.id,
        name: call.function.name,
        content: JSON.stringify({ error: outcome.error }),
      },
    };
  }

  const validation = parseAndValidateToolArguments(
    schema.function.parameters,
    call.function.arguments,
  );

  if (!validation.ok) {
    const outcome: ToolRunOutcome = {
      ok: false,
      output: null,
      error: `invalid arguments: ${validation.issues
        .map((i) => `${i.path || '<root>'} ${i.message}`)
        .join('; ')}`,
      durationMs: Date.now() - started,
    };
    return {
      outcome,
      message: {
        role: 'tool',
        toolCallId: call.id,
        name: call.function.name,
        content: JSON.stringify({ error: outcome.error, issues: validation.issues }),
      },
    };
  }

  const outcome = await runTool(call.function.name, validation.value);
  const payload = outcome.ok
    ? outcome.output
    : { error: outcome.error ?? 'tool failed' };
  return {
    outcome,
    message: {
      role: 'tool',
      toolCallId: call.id,
      name: call.function.name,
      content: typeof payload === 'string' ? payload : JSON.stringify(payload),
    },
  };
}

/**
 * Run the loop to completion (non-streaming) and return the final answer.
 * Ideal for the autonomous agent engine where a single result is required.
 */
export async function runToolLoop(
  base: Pick<ChatCompletionRequest, 'model' | 'messages'>,
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const {
    provider,
    toolSchemas,
    runTool,
    maxSteps = 8,
    temperature,
    maxTokens,
    toolChoice = 'auto',
    signal,
    onEvent,
  } = options;

  const schemas = schemaByName(toolSchemas);
  const messages: ChatCompletionMessage[] = [...base.messages];
  let usage = ZERO_USAGE;
  let step = 0;

  while (step < maxSteps) {
    step += 1;
    if (signal?.aborted) break;

    const result: ChatCompletionResult = await provider.complete({
      model: base.model,
      messages,
      tools: toolSchemas.length ? toolSchemas : undefined,
      toolChoice: toolSchemas.length ? toolChoice : undefined,
      temperature,
      maxTokens,
      signal,
    });
    usage = addUsage(usage, result.usage);

    if (result.toolCalls && result.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: result.content ?? '',
        toolCalls: result.toolCalls,
      });
      onEvent?.({ type: 'assistant', content: result.content, step });

      for (const call of result.toolCalls) {
        onEvent?.({ type: 'tool_call', toolCall: call, step });
        const { message, outcome } = await executeToolCall(call, schemas, runTool);
        messages.push(message);
        const args = safeParseArgs(call.function.arguments);
        onEvent?.({
          type: 'tool_result',
          toolResult: { ...outcome, toolId: call.function.name, args },
          step,
        });
      }
      continue;
    }

    messages.push({ role: 'assistant', content: result.content });
    onEvent?.({ type: 'final', content: result.content, step });
    return { content: result.content, messages, usage, steps: step, stopped: 'final' };
  }

  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  const content = last?.content ?? '';
  onEvent?.({ type: 'final', content, step });
  return { content, messages, usage, steps: step, stopped: 'max_steps' };
}

/**
 * Streaming variant. Yields incremental text from the model while transparently
 * executing any tools it requests, then continues streaming the final answer.
 */
export async function* streamToolLoop(
  base: Pick<ChatCompletionRequest, 'model' | 'messages'>,
  options: ToolLoopOptions,
): AsyncGenerator<ToolLoopEvent> {
  const {
    provider,
    toolSchemas,
    runTool,
    maxSteps = 8,
    temperature,
    maxTokens,
    toolChoice = 'auto',
    signal,
  } = options;

  const schemas = schemaByName(toolSchemas);
  const messages: ChatCompletionMessage[] = [...base.messages];
  let step = 0;

  while (step < maxSteps) {
    step += 1;
    if (signal?.aborted) break;

    let text = '';
    let toolCalls: ToolCall[] | undefined;

    for await (const chunk of provider.stream({
      model: base.model,
      messages,
      tools: toolSchemas.length ? toolSchemas : undefined,
      toolChoice: toolSchemas.length ? toolChoice : undefined,
      temperature,
      maxTokens,
      signal,
    })) {
      if (chunk.delta) {
        text += chunk.delta;
        yield { type: 'delta', delta: chunk.delta, step };
      }
      if (chunk.toolCalls) toolCalls = chunk.toolCalls;
      if (chunk.done) break;
    }

    if (toolCalls && toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: text, toolCalls });
      yield { type: 'assistant', content: text, step };
      for (const call of toolCalls) {
        yield { type: 'tool_call', toolCall: call, step };
        const { message, outcome } = await executeToolCall(call, schemas, runTool);
        messages.push(message);
        yield {
          type: 'tool_result',
          toolResult: {
            ...outcome,
            toolId: call.function.name,
            args: safeParseArgs(call.function.arguments),
          },
          step,
        };
      }
      continue;
    }

    messages.push({ role: 'assistant', content: text });
    yield { type: 'final', content: text, step };
    return;
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = raw.trim() === '' ? {} : JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
