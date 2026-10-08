import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// =============================================================================
// backend/tools/plugins.mjs
// -----------------------------------------------------------------------------
// Plugin / Extension SDK.
//
// The tool catalog is compiled in, which is exactly right for the first-party
// tools but makes it impossible for an operator to add a new capability without
// editing the core. This module adds a small, safe extension point: a directory
// of ES modules, each exporting one or more tool definitions, that are loaded at
// boot and registered into the SAME live tool registry the agent already uses.
//
// A plugin module may export (as its default export, or named `tools`):
//   - a single tool definition:
//       { id, description, parameters, dangerous?, handler(args, context) }
//   - an array of such definitions, or { tools: [ ...definitions ] }
//   - an advanced `register(registry)` function for full control.
//
// Loading is fail-soft and isolated: a broken plugin is reported and skipped, it
// never prevents the server/worker from booting, and it can never overwrite a
// first-party tool id.
// =============================================================================

const ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z0-9_]+)+$/;

/** Validate the shape of a single plugin tool definition. */
export function validatePluginDefinition(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('PLUGIN_DEFINITION_INVALID');
  const { id, description, parameters, handler } = definition;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('PLUGIN_ID_INVALID');
  if (typeof description !== 'string' || description.trim().length < 3) throw new Error('PLUGIN_DESCRIPTION_INVALID');
  if (typeof handler !== 'function') throw new Error('PLUGIN_HANDLER_INVALID');
  if (parameters !== undefined && (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters))) {
    throw new Error('PLUGIN_PARAMETERS_INVALID');
  }
  return {
    id,
    description: description.trim(),
    parameters: parameters ?? { type: 'object', additionalProperties: true, properties: {} },
    dangerous: definition.dangerous === true,
    handler,
  };
}

function collectDefinitions(module) {
  const exported = module?.default ?? module;
  if (typeof exported === 'function') return { register: exported };
  if (Array.isArray(exported)) return { definitions: exported };
  if (exported && Array.isArray(exported.tools)) return { definitions: exported.tools };
  if (exported && typeof exported.register === 'function') return { register: exported.register };
  if (exported && exported.id) return { definitions: [exported] };
  return { definitions: [] };
}

/**
 * Load every plugin module in `dir` and register its tools into `registry`.
 * @returns {Promise<{ loaded: string[], failed: Array<{file:string,error:string}>, skipped: string[] }>}
 */
export async function loadToolPlugins({ dir, registry, reservedIds = null, logger = () => {} } = {}) {
  const result = { loaded: [], failed: [], skipped: [] };
  if (!dir || !registry || typeof registry.register !== 'function') return result;
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return result; } // no plugin directory configured -> nothing to do

  const reserved = reservedIds instanceof Set ? reservedIds : new Set();
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    const file = path.join(dir, entry.name);
    try {
      const module = await import(pathToFileURL(file).href);
      const { definitions = [], register } = collectDefinitions(module);
      if (typeof register === 'function') {
        register(registry);
        result.loaded.push(`${entry.name}:register`);
        logger('plugin.registered', { file: entry.name, mode: 'register' });
        continue;
      }
      if (!definitions.length) { result.skipped.push(entry.name); continue; }
      for (const raw of definitions) {
        const definition = validatePluginDefinition(raw);
        if (reserved.has(definition.id)) { result.skipped.push(`${entry.name}:${definition.id}:reserved`); continue; }
        registry.register(definition, definition.handler);
        result.loaded.push(definition.id);
        logger('plugin.registered', { file: entry.name, toolId: definition.id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push({ file: entry.name, error: message });
      logger('plugin.failed', { file: entry.name, error: message });
    }
  }
  return result;
}

/** Convenience: load plugins from the TOOL_PLUGINS_DIR environment variable. */
export async function loadPluginsFromEnv({ registry, env = process.env, reservedIds = null, logger } = {}) {
  const dir = env.TOOL_PLUGINS_DIR ? path.resolve(env.TOOL_PLUGINS_DIR) : null;
  if (!dir) return { loaded: [], failed: [], skipped: [] };
  return loadToolPlugins({ dir, registry, reservedIds, logger });
}
