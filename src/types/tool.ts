export type ToolParameterType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object';

export interface ToolParameter {
  name: string;
  type: ToolParameterType;
  description: string;
  required?: boolean;
  default?: unknown;
  enumValues?: string[];
  /** For array parameters: the item type (defaults to string). */
  items?: ToolParameterType;
  /** Numeric bounds forwarded to the JSON schema. */
  minimum?: number;
  maximum?: number;
}

export type ToolCategory =
  | 'web'
  | 'code'
  | 'data'
  | 'files'
  | 'media'
  | 'system'
  | 'productivity'
  | 'ai'
  | 'github'
  | 'zip';

export interface ToolDefinition {
  id: string;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  category: ToolCategory;
  parameters: ToolParameter[];
  /** Whether the tool performs side effects (writes, network calls). */
  dangerous?: boolean;
  icon?: string;
  /** Human-readable description of the tool's return value. */
  returns?: string;
  /** Emit a strict JSON schema (OpenAI structured outputs). */
  strict?: boolean;
}

export interface ToolInvocation {
  id: string;
  toolId: string;
  args: Record<string, unknown>;
  startedAt: string;
  finishedAt?: string;
  status: 'pending' | 'running' | 'success' | 'error';
  output?: unknown;
  error?: string;
  durationMs?: number;
}
