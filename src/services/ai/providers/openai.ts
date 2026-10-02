/**
 * Real OpenAI provider (Chat Completions API).
 *
 * Supports:
 *   • function/tool calling (`tools`, `tool_choice`)
 *   • streaming via Server-Sent Events
 *   • tool-result messages (`role: 'tool'` + `tool_call_id`)
 *
 * Works against any OpenAI-compatible gateway (Azure OpenAI, OpenRouter,
 * Together, Groq, vLLM…) by overriding `baseUrl`.
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

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

interface OpenAIChoiceMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: OpenAIChoiceMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function mapFinishReason(reason: string | null | undefined): ChatCompletionResult['finishReason'] {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'stop':
      return 'stop';
    default:
      return reason ? 'stop' : 'stop';
  }
}

/** Internal messages → OpenAI wire format. */
export function toOpenAIMessages(
  messages: ChatCompletionMessage[],
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) };
  });
}

export class OpenAIProvider implements LLMProvider {
  readonly id: ProviderId = 'openai';
  readonly live = true;

  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly resolveApiModel: (modelId: string) => string;

  constructor(private options: ProviderFactoryOptions) {
    const { config } = options;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    this.headers = {
      Authorization: `Bearer ${config.apiKey ?? ''}`,
      ...(config.headers ?? {}),
    };
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.resolveApiModel =
      options.resolveApiModel ?? ((modelId) => getModel(modelId)?.apiModel ?? modelId);
  }

  private buildBody(req: ChatCompletionRequest, stream: boolean) {
    const body: Record<string, unknown> = {
      model: this.resolveApiModel(req.model),
      messages: toOpenAIMessages(req.messages),
    };
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens;
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools;
      const choice = normalizeToolChoice(req.toolChoice);
      body.tool_choice = choice.openai;
    }
    return body;
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const body = this.buildBody(req, false);
    const data = await postJson<OpenAIResponse>(`${this.baseUrl}/chat/completions`, {
      headers: this.headers,
      body,
      signal: req.signal,
      timeoutMs: this.timeoutMs,
    });

    const choice = data.choices?.[0];
    const content = choice?.message?.content ?? '';
    const toolCalls: ToolCall[] | undefined = choice?.message?.tool_calls?.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    return {
      id: data.id ?? newCompletionId(),
      model: data.model ?? req.model,
      content,
      usage: normalizeUsage(data.usage, estimateUsage(req, content)),
      finishReason: toolCalls?.length ? 'tool_calls' : mapFinishReason(choice?.finish_reason),
      toolCalls,
      raw: data,
    };
  }

  async *stream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const body = this.buildBody(req, true);
    const id = newCompletionId();

    const toolAccumulator = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: ChatCompletionResult['finishReason'] = 'stop';

    try {
      for await (const event of streamSse(`${this.baseUrl}/chat/completions`, {
        headers: this.headers,
        body,
        signal: req.signal,
        timeoutMs: this.timeoutMs,
      })) {
        if (event.data === '[DONE]') break;
        let parsed: OpenAIStreamChunk;
        try {
          parsed = JSON.parse(event.data) as OpenAIStreamChunk;
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;

        if (delta?.content) {
          yield { id, delta: delta.content, done: false };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const current =
              toolAccumulator.get(tc.index) ?? { id: '', name: '', args: '' };
            if (tc.id) current.id = tc.id;
            if (tc.function?.name) current.name += tc.function.name;
            if (tc.function?.arguments) current.args += tc.function.arguments;
            toolAccumulator.set(tc.index, current);
          }
        }
        if (choice?.finish_reason) {
          finishReason = mapFinishReason(choice.finish_reason);
        }
      }

      const toolCalls: ToolCall[] = Array.from(toolAccumulator.values())
        .filter((t) => t.name)
        .map((t) => ({
          id: t.id || newCompletionId('call'),
          type: 'function',
          function: { name: t.name, arguments: t.args || '{}' },
        }));

      yield { id, delta: '', done: true, finishReason, toolCalls: toolCalls.length ? toolCalls : undefined };
    } catch (error) {
      if (error instanceof StreamingUnsupportedError) {
        // Fallback: single-shot completion emitted as one chunk.
        const result = await this.complete(req);
        if (result.content) yield { id, delta: result.content, done: false };
        yield {
          id,
          delta: '',
          done: true,
          finishReason: result.finishReason,
          toolCalls: result.toolCalls,
        };
        return;
      }
      throw error;
    }
  }
}

export function createOpenAIProvider(options: ProviderFactoryOptions): LLMProvider {
  return new OpenAIProvider(options);
}
