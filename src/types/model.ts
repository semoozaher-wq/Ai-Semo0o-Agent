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
  /**
   * Default REST base URL for the provider. Real providers read this so the
   * same code works against OpenAI, Azure, OpenRouter, or a local gateway.
   */
  baseUrl?: string;
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
  /**
   * The provider-native model id sent over the wire. When omitted the `id`
   * field is used (e.g. `gpt-4o-mini`). This lets the UI show friendly names
   * while the API receives the exact model slug.
   */
  apiModel?: string;
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/* -------------------------------------------------------------------------- */
/*  JSON Schema (precise tool contracts)                                       */
/* -------------------------------------------------------------------------- */

export type JSONSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null';

/**
 * A pragmatic subset of JSON Schema (draft-07) covering everything the tool
 * layer needs. This is the exact shape sent to OpenAI `tools[].function.parameters`,
 * Google `functionDeclarations[].parameters`, and Anthropic `tools[].input_schema`.
 */
export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: (string | number | boolean)[];
  default?: unknown;
  additionalProperties?: boolean | JSONSchema;
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/** A single callable function advertised to the model. */
export interface ToolFunctionSchema {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** OpenAI structured-outputs flag. Ignored by providers that lack it. */
  strict?: boolean;
}

/** OpenAI-style tool descriptor (`{ type: 'function', function: {...} }`). */
export interface ToolSchema {
  type: 'function';
  function: ToolFunctionSchema;
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

/* -------------------------------------------------------------------------- */
/*  Messages / requests / responses                                            */
/* -------------------------------------------------------------------------- */

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded argument object, exactly as returned by the model. */
    arguments: string;
  };
}

export interface ChatCompletionMessage {
  role: ChatRole;
  content: string;
  name?: string;
  /** Set on `role: 'tool'` messages to bind the result to its call. */
  toolCallId?: string;
  /** Set on `role: 'assistant'` messages that requested tools. */
  toolCalls?: ToolCall[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** JSON-schema tool descriptors. */
  tools?: ToolSchema[];
  toolChoice?: ToolChoice;
  /** Optional structured JSON response contract for planning/extraction. */
  responseFormat?: {
    type: 'json_schema';
    jsonSchema: {
      name: string;
      strict?: boolean;
      schema: Record<string, unknown>;
    };
  };
  /** Abort in-flight network requests. */
  signal?: AbortSignal;
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
  /** Present when `finishReason === 'tool_calls'`. */
  toolCalls?: ToolCall[];
  /** Raw provider payload, useful for debugging. */
  raw?: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  delta: string;
  done: boolean;
  /** Emitted (typically on the final chunk) when the model requests tools. */
  toolCalls?: ToolCall[];
  finishReason?: ChatCompletionResult['finishReason'];
}

/* -------------------------------------------------------------------------- */
/*  Provider runtime configuration                                             */
/* -------------------------------------------------------------------------- */

export interface ProviderConfig {
  apiKey?: string;
  /** Override the REST base URL (Azure, OpenRouter, self-hosted gateway…). */
  baseUrl?: string;
  /** Extra headers merged into every request (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

export type ProviderConfigMap = Partial<Record<ProviderId, ProviderConfig>>;
