import {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionRequest,
  ChatCompletionResult,
  ProviderConfig,
  ProviderId,
  TokenUsage,
} from '../../types/model';
import { estimateTokens } from '../../utils/text';
import { uid } from '../../utils/id';

/**
 * The contract every model backend implements. Real HTTP providers (OpenAI,
 * Gemini, Anthropic) satisfy this interface, so the
 * rest of the app never needs to know which one is active.
 */
export interface LLMProvider {
  id: ProviderId;
  /** True when the provider is ready to make real network calls. */
  readonly live: boolean;
  complete(req: ChatCompletionRequest): Promise<ChatCompletionResult>;
  stream(req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk>;
}

/** Rough token accounting used when a provider omits usage metadata. */
export function estimateUsage(
  req: ChatCompletionRequest,
  output: string,
): TokenUsage {
  const promptTokens = req.messages.reduce(
    (acc, m) => acc + estimateTokens(m.content) + (m.toolCalls ? 24 : 0),
    0,
  );
  const completionTokens = estimateTokens(output);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

export function normalizeUsage(raw: unknown, fallback: TokenUsage): TokenUsage {
  if (!raw || typeof raw !== 'object') return fallback;
  const u = raw as Record<string, unknown>;
  const prompt = Number(u.prompt_tokens ?? u.promptTokenCount ?? u.input_tokens);
  const completion = Number(
    u.completion_tokens ?? u.candidatesTokenCount ?? u.output_tokens,
  );
  const total = Number(u.total_tokens ?? u.totalTokenCount);
  if (Number.isNaN(prompt) && Number.isNaN(completion)) return fallback;
  const p = Number.isNaN(prompt) ? fallback.promptTokens : prompt;
  const c = Number.isNaN(completion) ? fallback.completionTokens : completion;
  return {
    promptTokens: p,
    completionTokens: c,
    totalTokens: Number.isNaN(total) ? p + c : total,
  };
}

export function newCompletionId(prefix = 'cmpl'): string {
  return uid(prefix);
}

export interface ProviderFactoryOptions {
  config: ProviderConfig;
  /** Model id → provider-native slug resolver. */
  resolveApiModel?: (modelId: string) => string;
}

export type ProviderFactory = (options: ProviderFactoryOptions) => LLMProvider;

/** Convert internal messages into a plain array safe to JSON-serialize. */
export function serializeMessages(
  messages: ChatCompletionMessage[],
): ChatCompletionMessage[] {
  return messages.map((m) => ({ ...m }));
}
