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
}

export type ToolCategory =
  | 'web'
  | 'code'
  | 'data'
  | 'files'
  | 'media'
  | 'system'
  | 'productivity'
  | 'ai';

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
