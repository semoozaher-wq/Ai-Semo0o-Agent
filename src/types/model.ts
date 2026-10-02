export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'mistral'
  | 'meta'
  | 'local';

export interface ModelProvider {
  id: ProviderId;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  docsUrl?: string;
  requiresApiKey: boolean;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsEmbeddings: boolean;
  /** Brand accent color used across the UI. */
  accent: string;
}

export type ModelCapability =
  | 'chat'
  | 'vision'
  | 'tools'
  | 'code'
  | 'reasoning'
  | 'embeddings'
  | 'long-context';

export interface ModelSpec {
  id: string;
  provider: ProviderId;
  name: string;
  description: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: ModelCapability[];
  inputPricePerMTokens: number;
  outputPricePerMTokens: number;
  /** 1 (slow) – 5 (very fast) */
  speed: number;
  /** 1 (basic) – 5 (state of the art) */
  quality: number;
  recommended?: boolean;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatCompletionMessage {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: string[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResult {
  id: string;
  model: string;
  content: string;
  usage: TokenUsage;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
}

export interface ChatCompletionChunk {
  id: string;
  delta: string;
  done: boolean;
}
