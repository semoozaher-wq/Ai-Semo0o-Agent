/**
 * Real Google Gemini provider (Generative Language REST API).
 *
 * Supports:
 *   • function calling (`tools[].functionDeclarations`, `toolConfig`)
 *   • streaming via `:streamGenerateContent?alt=sse`
 *   • function responses fed back as a `user` turn with `functionResponse` parts
 *
 * Endpoint shape:
 *   POST {baseUrl}/models/{model}:generateContent?key=API_KEY
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

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: {
    content?: GeminiContent;
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function mapFinishReason(reason: string | undefined, hasTools: boolean): ChatCompletionResult['finishReason'] {
  if (hasTools) return 'tool_calls';
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
    default:
      return 'stop';
  }
}

/** Convert internal messages to Gemini `contents` + `systemInstruction`. */
export function toGeminiContents(messages: ChatCompletionMessage[]): {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] } | undefined;
} {
  const systemTexts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemTexts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: safeParse(tc.function.arguments),
            },
          });
        }
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    if (m.role === 'tool') {
      const response = safeParse(m.content);
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name ?? 'tool',
              response:
                response && typeof response === 'object'
                  ? (response as Record<string, unknown>)
                  : { result: m.content },
            },
          },
        ],
      });
    }
  }

  return {
    contents,
    systemInstruction: systemTexts.length
      ? { parts: [{ text: systemTexts.join('\n\n') }] }
      : undefined,
  };
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = raw.trim() === '' ? {} : JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { raw };
  }
}

function extractParts(response: GeminiResponse): {
  text: string;
  toolCalls: ToolCall[];
} {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  let text = '';
  const toolCalls: ToolCall[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string') text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: uid('call'),
        type: 'function',
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }
  return { text, toolCalls };
}

export class GeminiProvider implements LLMProvider {
  readonly id: ProviderId = 'google';
  readonly live = true;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly resolveApiModel: (modelId: string) => string;

  constructor(private options: ProviderFactoryOptions) {
    const { config } = options;
    this.baseUrl = (
      config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/$/, '');
    this.apiKey = config.apiKey ?? '';
    this.headers = { ...(config.headers ?? {}) };
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.resolveApiModel =
      options.resolveApiModel ?? ((modelId) => getModel(modelId)?.apiModel ?? modelId);
  }

  private buildBody(req: ChatCompletionRequest) {
    const { contents, systemInstruction } = toGeminiContents(req.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const generationConfig: Record<string, unknown> = {};
    if (typeof req.temperature === 'number') generationConfig.temperature = req.temperature;
    if (typeof req.maxTokens === 'number') generationConfig.maxOutputTokens = req.maxTokens;
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    if (req.tools && req.tools.length > 0) {
      // Convert the OpenAI-style tool schemas back into Gemini declarations.
      body.tools = openAiToolsToGemini(req.tools);
      const choice = normalizeToolChoice(req.toolChoice);
      body.toolConfig = {
        functionCallingConfig:
          typeof choice.gemini === 'string'
            ? { mode: choice.gemini }
            : { mode: 'ANY', allowedFunctionNames: choice.gemini.allowedFunctionNames },
      };
    }
    return body;
  }

  private endpoint(model: string, method: 'generateContent' | 'streamGenerateContent', stream: boolean) {
    const slug = this.resolveApiModel(model);
    const query = stream ? `?alt=sse&key=${this.apiKey}` : `?key=${this.apiKey}`;
    return `${this.baseUrl}/models/${slug}:${method}${query}`;
  }

  async complete(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    const data = await postJson<GeminiResponse>(
      this.endpoint(req.model, 'generateContent', false),
      { headers: this.headers, body: this.buildBody(req), signal: req.signal, timeoutMs: this.timeoutMs },
    );
    const { text, toolCalls } = extractParts(data);
    return {
      id: newCompletionId(),
      model: req.model,
      content: text,
      usage: normalizeUsage(data.usageMetadata, estimateUsage(req, text)),
      finishReason: mapFinishReason(data.candidates?.[0]?.finishReason, toolCalls.length > 0),
      toolCalls: toolCalls.length ? toolCalls : undefined,
      raw: data,
    };
  }

  async *stream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const id = newCompletionId();
    const toolCalls: ToolCall[] = [];
    let finishReason: ChatCompletionResult['finishReason'] = 'stop';
    try {
      for await (const event of streamSse(
        this.endpoint(req.model, 'streamGenerateContent', true),
        { headers: this.headers, body: this.buildBody(req), signal: req.signal, timeoutMs: this.timeoutMs },
      )) {
        let parsed: GeminiResponse;
        try {
          parsed = JSON.parse(event.data) as GeminiResponse;
        } catch {
          continue;
        }
        const { text, toolCalls: calls } = extractParts(parsed);
        if (text) yield { id, delta: text, done: false };
        if (calls.length) toolCalls.push(...calls);
        if (parsed.candidates?.[0]?.finishReason) {
          finishReason = mapFinishReason(parsed.candidates[0].finishReason, false);
        }
      }
      if (toolCalls.length) finishReason = 'tool_calls';
      yield {
        id,
        delta: '',
        done: true,
        finishReason,
        toolCalls: toolCalls.length ? toolCalls : undefined,
      };
    } catch (error) {
      if (error instanceof StreamingUnsupportedError) {
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

/** Adapter: OpenAI tool schemas → Gemini functionDeclarations. */
function openAiToolsToGemini(
  tools: NonNullable<ChatCompletionRequest['tools']>,
): unknown[] {
  const declarations = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: toGeminiParameters(tool.function.parameters),
  }));
  return [{ functionDeclarations: declarations }];
}

type JsonSchema = NonNullable<ChatCompletionRequest['tools']>[number]['function']['parameters'];

function toGeminiParameters(node: JsonSchema): Record<string, unknown> {
  const rawType = Array.isArray(node.type) ? node.type[0] ?? 'string' : node.type ?? 'string';
  const out: Record<string, unknown> = {
    type: rawType.toUpperCase(),
  };
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = node.enum;
  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([k, v]) => [k, toGeminiParameters(v)]),
    );
  }
  if (node.items) out.items = toGeminiParameters(node.items);
  if (node.required?.length) out.required = node.required;
  return out;
}

export function createGeminiProvider(options: ProviderFactoryOptions): LLMProvider {
  return new GeminiProvider(options);
}
