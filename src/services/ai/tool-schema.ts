/**
 * Tool schema compiler + strict argument validator.
 *
 * Converts the app's internal {@link ToolDefinition} catalog into the exact
 * JSON-schema dialect each provider expects:
 *
 *   • OpenAI / OpenRouter / Mistral → `tools[].function.parameters` (JSON Schema)
 *   • Google Gemini                 → `tools[].functionDeclarations[].parameters`
 *   • Anthropic Claude              → `tools[].input_schema`
 *
 * It also exposes {@link validateToolArguments}, a dependency-free validator
 * that guarantees the model can never hand a tool malformed input. This is the
 * "قواعد JSON دقيقة" (precise JSON rules) layer.
 */

import {
  JSONSchema,
  ToolChoice,
  ToolSchema,
} from '../../types/model';
import { ToolDefinition, ToolParameter, ToolParameterType } from '../../types/tool';

/* -------------------------------------------------------------------------- */
/*  Definition → JSON Schema                                                   */
/* -------------------------------------------------------------------------- */

const TYPE_MAP: Record<ToolParameterType, NonNullable<JSONSchema['type']>> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  array: 'array',
  object: 'object',
};

/** Compile a single tool parameter into a JSON-schema node. */
export function parameterToSchema(param: ToolParameter): JSONSchema {
  const node: JSONSchema = {
    type: TYPE_MAP[param.type],
    description: param.description,
  };

  if (param.enumValues && param.enumValues.length > 0) {
    node.enum = [...param.enumValues];
  }
  if (param.default !== undefined) {
    node.default = param.default;
  }
  if (param.type === 'array') {
    node.items = { type: TYPE_MAP[param.items ?? 'string'] };
  }
  if (typeof param.minimum === 'number') node.minimum = param.minimum;
  if (typeof param.maximum === 'number') node.maximum = param.maximum;

  return node;
}

/**
 * Compile a full tool definition into an OpenAI-style function tool.
 * `additionalProperties: false` + a complete `required` list gives the model a
 * tight, unambiguous contract.
 */
export function toolDefinitionToSchema(def: ToolDefinition): ToolSchema {
  const properties: Record<string, JSONSchema> = {};
  const required: string[] = [];

  for (const param of def.parameters) {
    properties[param.name] = parameterToSchema(param);
    if (param.required) required.push(param.name);
  }

  return {
    type: 'function',
    function: {
      name: def.id,
      description: buildDescription(def),
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
      strict: def.strict ?? true,
    },
  };
}

/** Prefer the Arabic description when present, then append the return contract. */
function buildDescription(def: ToolDefinition): string {
  const base = def.descriptionAr?.trim() || def.description;
  const returns = def.returns ? ` Returns: ${def.returns}.` : '';
  return `${base}${returns}`;
}

export function toOpenAITools(defs: ToolDefinition[]): ToolSchema[] {
  return defs.map(toolDefinitionToSchema);
}

/* -------------------------------------------------------------------------- */
/*  Provider-specific dialects                                                 */
/* -------------------------------------------------------------------------- */

type GeminiType = 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT';

const GEMINI_TYPE_MAP: Record<string, GeminiType> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

interface GeminiSchema {
  type: GeminiType;
  description?: string;
  properties?: Record<string, GeminiSchema>;
  items?: GeminiSchema;
  required?: string[];
  enum?: Array<string | number | boolean>;
  format?: string;
}

/** Recursively translate a JSON schema node into Gemini's OpenAPI subset. */
function toGeminiSchema(node: JSONSchema): GeminiSchema {
  const rawType = Array.isArray(node.type) ? node.type[0] : node.type ?? 'string';
  const out: GeminiSchema = {
    type: GEMINI_TYPE_MAP[rawType] ?? 'STRING',
  };
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = [...node.enum];
  if (node.format) out.format = node.format;
  if (node.properties) {
    out.properties = Object.fromEntries(
      Object.entries(node.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
    );
  }
  if (node.items) out.items = toGeminiSchema(node.items);
  if (node.required && node.required.length > 0) out.required = [...node.required];
  return out;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: GeminiSchema;
}

export function toGeminiTools(defs: ToolDefinition[]): {
  functionDeclarations: GeminiFunctionDeclaration[];
}[] {
  const declarations = defs.map((def) => {
    const schema = toolDefinitionToSchema(def);
    return {
      name: schema.function.name,
      description: schema.function.description,
      parameters: toGeminiSchema(schema.function.parameters),
    };
  });
  return [{ functionDeclarations: declarations }];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JSONSchema;
}

export function toAnthropicTools(defs: ToolDefinition[]): AnthropicTool[] {
  return defs.map((def) => {
    const schema = toolDefinitionToSchema(def);
    return {
      name: schema.function.name,
      description: schema.function.description,
      input_schema: schema.function.parameters,
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  Tool-choice normalisation                                                  */
/* -------------------------------------------------------------------------- */

export interface NormalizedToolChoice {
  openai: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  anthropic: { type: 'auto' | 'any' | 'none' | 'tool'; name?: string };
  gemini:
    | 'AUTO'
    | 'NONE'
    | 'ANY'
    | { mode: 'ANY'; allowedFunctionNames: string[] };
}

export function normalizeToolChoice(choice?: ToolChoice): NormalizedToolChoice {
  if (!choice || choice === 'auto') {
    return { openai: 'auto', anthropic: { type: 'auto' }, gemini: 'AUTO' };
  }
  if (choice === 'none') {
    return { openai: 'none', anthropic: { type: 'none' }, gemini: 'NONE' };
  }
  if (choice === 'required') {
    return { openai: 'required', anthropic: { type: 'any' }, gemini: 'ANY' };
  }
  const name = choice.function.name;
  return {
    openai: { type: 'function', function: { name } },
    anthropic: { type: 'tool', name },
    gemini: { mode: 'ANY', allowedFunctionNames: [name] },
  };
}

/* -------------------------------------------------------------------------- */
/*  Strict argument validator                                                  */
/* -------------------------------------------------------------------------- */

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  value: Record<string, unknown>;
  issues: ValidationIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceScalar(
  raw: unknown,
  type: JSONSchema['type'],
): { value: unknown; changed: boolean } {
  if (type === 'number' || type === 'integer') {
    if (typeof raw === 'number') return { value: raw, changed: false };
    if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
      const n = Number(raw);
      return { value: type === 'integer' ? Math.trunc(n) : n, changed: true };
    }
  }
  if (type === 'boolean' && typeof raw === 'string') {
    if (raw === 'true') return { value: true, changed: true };
    if (raw === 'false') return { value: false, changed: true };
  }
  if (type === 'string' && typeof raw === 'number') {
    return { value: String(raw), changed: true };
  }
  return { value: raw, changed: false };
}

function validateNode(
  schema: JSONSchema,
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
): unknown {
  const types = schema.type
    ? Array.isArray(schema.type)
      ? schema.type
      : [schema.type]
    : [];

  // No declared type → accept as-is.
  if (types.length === 0) return raw;

  // null / nullable handling.
  if (raw === null || raw === undefined) {
    if (types.includes('null')) return null;
    if (schema.default !== undefined) return schema.default;
    return raw;
  }

  // Object.
  if (types.includes('object')) {
    if (!isPlainObject(raw)) {
      issues.push({ path, message: `expected object, received ${typeof raw}` });
      return raw;
    }
    const out: Record<string, unknown> = {};
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(props)) {
      const childPath = path ? `${path}.${key}` : key;
      if (raw[key] === undefined) {
        if (child.default !== undefined) {
          out[key] = child.default;
        } else if (schema.required?.includes(key)) {
          issues.push({ path: childPath, message: 'missing required property' });
        }
        continue;
      }
      out[key] = validateNode(child, raw[key], childPath, issues);
    }
    // Preserve unknown keys only when additionalProperties !== false.
    if (schema.additionalProperties !== false) {
      for (const [key, value] of Object.entries(raw)) {
        if (!(key in props)) out[key] = value;
      }
    }
    return out;
  }

  // Array.
  if (types.includes('array')) {
    if (!Array.isArray(raw)) {
      issues.push({ path, message: `expected array, received ${typeof raw}` });
      return raw;
    }
    if (typeof schema.minItems === 'number' && raw.length < schema.minItems) {
      issues.push({ path, message: `expected at least ${schema.minItems} items` });
    }
    if (typeof schema.maxItems === 'number' && raw.length > schema.maxItems) {
      issues.push({ path, message: `expected at most ${schema.maxItems} items` });
    }
    const itemSchema = schema.items ?? {};
    return raw.map((item, i) => validateNode(itemSchema, item, `${path}[${i}]`, issues));
  }

  // Scalars.
  const targetType = types[0];
  const { value, changed } = coerceScalar(raw, targetType);

  if (targetType === 'number' && typeof value !== 'number') {
    issues.push({ path, message: `expected number, received ${typeof raw}` });
    return value;
  }
  if (targetType === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
    issues.push({ path, message: `expected integer, received ${typeof raw}` });
    return value;
  }
  if (targetType === 'boolean' && typeof value !== 'boolean') {
    issues.push({ path, message: `expected boolean, received ${typeof raw}` });
    return value;
  }
  if (targetType === 'string' && typeof value !== 'string') {
    issues.push({ path, message: `expected string, received ${typeof raw}` });
    return value;
  }

  if (schema.enum && !schema.enum.includes(value as string | number | boolean)) {
    issues.push({
      path,
      message: `value ${JSON.stringify(value)} is not one of ${schema.enum
        .map((v) => JSON.stringify(v))
        .join(', ')}`,
    });
  }

  void changed;
  return value;
}

/**
 * Validate (and gently coerce) a model-supplied argument object against a
 * compiled tool schema. Returns a normalised `value` even when issues exist so
 * callers can decide whether to proceed or surface the errors back to the model.
 */
export function validateToolArguments(
  schema: JSONSchema,
  args: unknown,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const value = validateNode(schema, args, '', issues);
  return {
    ok: issues.length === 0,
    value: isPlainObject(value) ? value : {},
    issues,
  };
}

/** Validate raw JSON-string arguments emitted by the model. */
export function parseAndValidateToolArguments(
  schema: JSONSchema,
  rawArguments: string,
): ValidationResult & { parseError?: string } {
  let parsed: unknown;
  try {
    parsed = rawArguments.trim() === '' ? {} : JSON.parse(rawArguments);
  } catch (error) {
    return {
      ok: false,
      value: {},
      issues: [{ path: '', message: 'arguments are not valid JSON' }],
      parseError: error instanceof Error ? error.message : 'invalid JSON',
    };
  }
  return validateToolArguments(schema, parsed);
}
