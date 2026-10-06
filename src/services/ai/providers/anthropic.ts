/**
 * Real Anthropic (Claude) provider — Messages API.
 *
 * Supports:
 *   • tool use (`tools[].input_schema`, `tool_choice`)
 *   • streaming via Server-Sent Events
 *   • tool results fed back as a `user` turn with `tool_result` blocks
 */

import {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResult,
  ProviderId,
  ToolCall,
} from '../../../types/model';
import { getModel } from '../../../data/models';
import { normalizeToolChoice } from '../tool-schema';
import { postJson, streamSse, StreamingUnsupportedError } from '../http';
import {
  LLMProvider,
  ProviderFactoryOptions,
  estimateUsage,
  newCompletionId,
  normalizeUsage,
} from '../provider';
import { uid } from '../../../utils/id';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicBlock[];
  stop_reason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = raw.trim() === '' ? {} : JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { raw };
  }
}

function mapStopReason(reason: string | null | undefined): ChatCompletionResult['finishReason'] {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'stop';
  }
}

/** Internal messages → Anthropic `system` + `messages`. */
export function toAnthropicMessages(messages: ChatCompletionMessage[]): {
  system?: string | undefined;
  messages: AnthropicMessage[];
} {
  const systemTexts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemTexts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: safeParse(tc.function.arguments),
          });
        }
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.content,
          },
        ],
      });
    }
  }

  return { system: systemTexts.length ? systemTexts.join('\n\n') : undefined, messages: out };
}

export class AnthropicProvider implements LLMProvider {
  readonly id: ProviderId = 'anthropic';
  readonly live = true;

  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly resolveApiModel: (modelId: string) => string;

  constructor(private options: ProviderFactoryOptions) {
    const { config } = options;
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.headers = {
      'x-api-key': config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
      ...(config.headers ?? {}),
    };
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.resolveApiModel =
      options.resolveApiModel ?? ((modelId) => getModel(modelId)?.apiModel ?? modelId);
  }

  private buildBody(req: ChatCompletionRequest, stream: boolean) {
    const { system, messages } = toAnthropicMessages(req.messages);
    const body: Record<string, unknown> = {
      model: this.resolveApiModel(req.model),
      max_tokens: req.maxTokens ?? 4096,
      messages,
    };
    if (system) body.system = system;
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (stream) body.stream = true;
    if (req.tools && req.tools.length > 0) {
      body.tools = toAnthropicToolsFromSchemas(req.tools);
      const choice = normalizeToolChoice(req.toolChoice);
      body.tool_choice =
        choice.anthropic.type === 'tool'
          ? { type: 'tool', name: choice.anthropic.name }
          : { type: choice.anthropic.type };
    }
    return body;
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const data = await postJson<AnthropicResponse>(`${this.baseUrl}/messages`, {
      headers: this.headers,
      body: this.buildBody(req, false),
      signal: req.signal,
      timeoutMs: this.timeoutMs,
    });
    const { text, toolCalls } = extractBlocks(data.content);
    return {
      id: data.id ?? newCompletionId(),
      model: data.model ?? req.model,
      content: text,
      usage: normalizeUsage(data.usage, estimateUsage(req, text)),
      finishReason: mapStopReason(data.stop_reason),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: data,
    };
  }

  async *stream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const id = newCompletionId();
    const toolCalls: ToolCall[] = [];
    let finishReason: ChatCompletionResult['finishReason'] = 'stop';
    // Track in-progress tool_use blocks by index.
    const pending = new Map<number, { id: string; name: string; json: string }>();

    try {
      for await (const event of streamSse(`${this.baseUrl}/messages`, {
        headers: this.headers,
        body: this.buildBody(req, true),
        signal: req.signal,
        timeoutMs: this.timeoutMs,
      })) {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          continue;
        }
        const type = payload.type as string;
        if (type === 'content_block_start') {
          const block = payload.content_block as { type: string; id?: string; name?: string };
          if (block?.type === 'tool_use') {
            pending.set(Number(payload.index), {
              id: block.id ?? uid('call'),
              name: block.name ?? '',
              json: '',
            });
          }
        } else if (type === 'content_block_delta') {
          const delta = payload.delta as {
            type: string;
            text?: string;
            partial_json?: string;
          };
          if (delta?.type === 'text_delta' && delta.text) {
            yield { id, delta: delta.text, done: false };
          } else if (delta?.type === 'input_json_delta') {
            const current = pending.get(Number(payload.index));
            if (current) current.json += delta.partial_json ?? '';
          }
        } else if (type === 'content_block_stop') {
          const current = pending.get(Number(payload.index));
          if (current) {
            toolCalls.push({
              id: current.id,
              type: 'function',
              function: { name: current.name, arguments: current.json || '{}' },
            });
            pending.delete(Number(payload.index));
          }
        } else if (type === 'message_delta') {
          const delta = payload.delta as { stop_reason?: string };
          if (delta?.stop_reason) finishReason = mapStopReason(delta.stop_reason);
        }
      }
      if (toolCalls.length) finishReason = 'tool_calls';
      yield { id, delta: '', done: true, finishReason, toolCalls: toolCalls.length ? toolCalls : undefined };
    } catch (error) {
      if (error instanceof StreamingUnsupportedError) {
        const result = await this.complete(req);
        if (result.content) yield { id, delta: result.content, done: false };
        yield { id, delta: '', done: true, finishReason: result.finishReason, toolCalls: result.toolCalls };
        return;
      }
      throw error;
    }
  }
}

function extractBlocks(blocks: AnthropicBlock[] | undefined): {
  text: string;
  toolCalls: ToolCall[];
} {
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const block of blocks ?? []) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  return { text, toolCalls };
}

/** OpenAI tool schemas → Anthropic tools (already JSON Schema compatible). */
function toAnthropicToolsFromSchemas(
  tools: NonNullable<ChatCompletionRequest['tools']>,
): { name: string; description: string; input_schema: unknown }[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

export function createAnthropicProvider(options: ProviderFactoryOptions): LLMProvider {
  return new AnthropicProvider(options);
}
