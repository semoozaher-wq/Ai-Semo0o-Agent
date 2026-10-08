// =============================================================================
// backend/agent/tool-schema.mjs
// -----------------------------------------------------------------------------
// Structured tool-argument validation.
//
// Every tool in the catalog already declares a JSON-Schema `parameters` object,
// but until now that schema was only ever handed to the model (as an OpenAI
// function schema) and never enforced on the server. A model could therefore call
// a tool with a wrong-typed or out-of-range argument and the handler would only
// fail later, deep inside its own ad-hoc checks.
//
// This module is a tiny, dependency-free validator for the JSON-Schema subset the
// catalog actually uses (type / enum / required / properties / additionalProperties
// / items / min-max / min-maxLength / min-maxItems). It is wired into the tool
// registry so malformed arguments are rejected up-front with a precise,
// machine-readable error.
//
// Two modes keep it safe to enable everywhere:
//   - safe (default): validate the TYPES/ENUMS/BOUNDS of the arguments that were
//     actually provided, and ignore unknown keys. This can never reject a call
//     that a handler would have accepted, so it is non-breaking.
//   - strict: additionally enforce `required` and reject unknown keys
//     (`additionalProperties:false`). Operators opt in with TOOL_ARG_STRICT=true.
// =============================================================================

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
}

/**
 * Validate `args` against a JSON-Schema-subset `schema`.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateArgs(schema, args, { strict = false, path = '' } = {}) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { valid: true, errors };
  const value = args === undefined ? {} : args;
  const where = path || 'args';

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${where}: expected ${schema.type}, got ${typeOf(value)}`);
    return { valid: false, errors };
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${where}: value ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeOf(value) === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    if (strict && Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (value[key] === undefined || value[key] === null) errors.push(`${where}.${key}: is required`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const childSchema = properties[key];
      if (!childSchema) {
        if (strict && schema.additionalProperties === false) errors.push(`${where}.${key}: unknown property`);
        continue;
      }
      const child = validateArgs(childSchema, item, { strict, path: `${where}.${key}` });
      errors.push(...child.errors);
    }
  }

  if (typeOf(value) === 'array') {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${where}: needs at least ${schema.minItems} item(s)`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${where}: allows at most ${schema.maxItems} item(s)`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => {
        errors.push(...validateArgs(schema.items, item, { strict, path: `${where}[${index}]` }).errors);
      });
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${where}: shorter than ${schema.minLength}`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${where}: longer than ${schema.maxLength}`);
  }

  if (typeOf(value) === 'number' || typeOf(value) === 'integer') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${where}: below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${where}: above maximum ${schema.maximum}`);
  }

  return { valid: errors.length === 0, errors };
}

/** Throw a precise, machine-readable error when arguments are invalid. */
export function assertValidArgs(toolId, schema, args, { strict = false } = {}) {
  const result = validateArgs(schema, args, { strict });
  if (!result.valid) {
    const error = new Error(`TOOL_ARGS_INVALID:${toolId}:${result.errors[0]}`);
    error.code = 'TOOL_ARGS_INVALID';
    error.toolId = toolId;
    error.details = result.errors;
    throw error;
  }
  return args;
}

/** Whether strict validation is requested by the environment. */
export function strictArgsEnabled(env = process.env) {
  return String(env.TOOL_ARG_STRICT ?? '').toLowerCase() === 'true';
}
