/**
 * Engine-backed tool handlers.
 *
 * These compose the EXISTING `AgentExecutionEngine` instead of touching the file
 * system directly, so every read / write / patch / scan / command / apply runs
 * inside the per-task workspace with the engine's permission gateway, atomic
 * writes, bounded terminal, and evidence trail. No new sandboxing is introduced
 * here: this module only adapts the engine's public API to the agent tool shape
 * (`(args, context) => Promise<{ output, ok? }>`).
 *
 * `workspace.apply` is the Edit -> Test -> Diagnose/Fix -> Retest loop: it reuses
 * `AgentExecutionEngine.executeTransaction`, which applies operations
 * transactionally, runs real verification commands, and (when an LLM is present
 * in the tool context) replans a fix before rolling back only agent-touched
 * files.
 */

export const ENGINE_TOOL_IDS = Object.freeze([
  'files.read',
  'files.write',
  'files.patch',
  'files.scan',
  'terminal.run',
  'workspace.apply',
]);

/**
 * Commands an AGENT may run. This is intentionally narrower than the engine's
 * terminal allow-list: the agent must never be able to reach Git directly, so
 * `git push` / `git merge` / `git checkout main` are impossible from a tool.
 * The Git lifecycle (status/diff/branch/checkpoint) stays in the engine's
 * `RealGit`, which structurally has no push/merge and refuses master/main.
 */
export const AGENT_TERMINAL_COMMANDS = Object.freeze(['node', 'npm', 'npx']);

function requireEngine(context) {
  const engine = context?.engine;
  if (!engine || !engine.files || !engine.terminal) {
    throw new Error('ENGINE_REQUIRED');
  }
  return engine;
}

function boundedText(value, max, name) {
  const text = String(value ?? '');
  if (!text || text.length > max) throw new Error(`${name}_OUT_OF_RANGE`);
  return text;
}

function optionalPositiveInt(value, maximum) {
  const resolved = Number(value);
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > maximum) return undefined;
  return resolved;
}

function parseJsonObject(text) {
  const match = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error('DIAGNOSIS_INVALID_JSON');
  return JSON.parse(match[0]);
}

const OPERATION_TYPES = new Set(['write', 'patch', 'delete']);

/** Validate and normalize the operation list before it reaches the engine. */
export function normalizeOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) throw new Error('APPLY_OPERATIONS_REQUIRED');
  if (operations.length > 50) throw new Error('APPLY_OPERATIONS_TOO_MANY');
  return operations.map((operation, index) => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      throw new Error(`APPLY_OPERATION_INVALID:${index}`);
    }
    const type = String(operation.type ?? '');
    if (!OPERATION_TYPES.has(type)) throw new Error(`APPLY_OPERATION_TYPE_INVALID:${index}`);
    if (typeof operation.path !== 'string' || operation.path.trim() === '') {
      throw new Error(`APPLY_OPERATION_PATH_INVALID:${index}`);
    }
    if (type === 'write') {
      if (typeof operation.content !== 'string') throw new Error(`APPLY_OPERATION_CONTENT_INVALID:${index}`);
      return { type, path: operation.path, content: operation.content };
    }
    if (type === 'patch') {
      if (typeof operation.expected !== 'string' || typeof operation.replacement !== 'string') {
        throw new Error(`APPLY_OPERATION_PATCH_INVALID:${index}`);
      }
      return { type, path: operation.path, expected: operation.expected, replacement: operation.replacement };
    }
    return { type, path: operation.path };
  });
}

/** Validate and normalize the verification command list. */
export function normalizeVerification(verification, allowedCommands = AGENT_TERMINAL_COMMANDS) {
  if (!Array.isArray(verification) || verification.length === 0) throw new Error('APPLY_VERIFICATION_REQUIRED');
  if (verification.length > 20) throw new Error('APPLY_VERIFICATION_TOO_MANY');
  const allowed = new Set(allowedCommands);
  return verification.map((command, index) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new Error(`APPLY_VERIFICATION_INVALID:${index}`);
    }
    const name = String(command.command ?? '');
    if (!name) throw new Error(`APPLY_VERIFICATION_COMMAND_INVALID:${index}`);
    if (!allowed.has(name)) throw new Error(`APPLY_VERIFICATION_COMMAND_NOT_ALLOWED:${name}`);
    const args = command.args ?? [];
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new Error(`APPLY_VERIFICATION_ARGS_INVALID:${index}`);
    }
    const normalized = { command: name, args };
    const timeoutMs = optionalPositiveInt(command.timeoutMs, 600_000);
    if (timeoutMs) normalized.timeoutMs = timeoutMs;
    return normalized;
  });
}

const DIAGNOSIS_SYSTEM =
  'You are diagnosing a failed edit inside an isolated task workspace. Return ONLY JSON: ' +
  '{"operations":[{"type":"write|patch|delete","path":string,"content"?:"...","expected"?:"...","replacement"?:"..."}],' +
  '"verification":[{"command":string,"args":[string]}]}. ' +
  'Only allow-listed commands are permitted (git, node, npm, npx). ' +
  'Never modify security, authentication, permissions, or CI policy.';

/**
 * Build the engine-backed handler map. A default engine may be supplied, but the
 * per-call `context.engine` always wins so a resolver can hand each task its own
 * isolated workspace engine.
 */
export function createEngineToolHandlers({ engine: defaultEngine, allowedCommands = AGENT_TERMINAL_COMMANDS } = {}) {
  const resolve = (context) => context?.engine ?? defaultEngine ?? requireEngine(context);
  const agentCommands = new Set(allowedCommands);

  return {
    'files.read': async (args = {}, context = {}) => {
      const engine = resolve(context);
      const result = await engine.files.read(args.path);
      const maxChars = optionalPositiveInt(args.maxChars, 200_000) ?? 200_000;
      return { output: { path: result.path, content: result.content.slice(0, maxChars), bytes: result.bytes, sha256: result.sha256 } };
    },

    'files.write': async (args = {}, context = {}) => {
      const engine = resolve(context);
      const result = await engine.files.write(args.path, boundedText(args.content, 200_000, 'CONTENT'));
      return { output: { path: result.path, bytes: result.bytes, created: result.created, sha256: result.sha256 } };
    },

    'files.patch': async (args = {}, context = {}) => {
      const engine = resolve(context);
      const result = await engine.files.patch(args.path, args.expected, args.replacement);
      return { output: { path: result.path, bytes: result.bytes, sha256: result.sha256 } };
    },

    'files.scan': async (args = {}, context = {}) => {
      const engine = resolve(context);
      const result = await engine.files.list({ scope: args.scope, maxFiles: optionalPositiveInt(args.maxFiles, 5_000) });
      return { output: { scope: result.scope, files: result.files, truncated: result.truncated } };
    },

    'terminal.run': async (args = {}, context = {}) => {
      const engine = resolve(context);
      const command = String(args.command ?? '');
      if (!agentCommands.has(command)) throw new Error(`COMMAND_NOT_ALLOWED_FOR_AGENT:${command}`);
      const result = await engine.terminal.run({
        command,
        args: Array.isArray(args.args) ? args.args : [],
        timeoutMs: optionalPositiveInt(args.timeoutMs, 600_000),
        maxOutputBytes: optionalPositiveInt(args.maxOutputBytes, 2_000_000),
      });
      return {
        output: {
          command: result.command,
          args: result.args,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          ok: result.ok,
        },
        ok: result.ok,
      };
    },

    'workspace.apply': async (args = {}, context = {}) => {
      const engine = resolve(context);
      const operations = normalizeOperations(args.operations);
      const verification = normalizeVerification(args.verification, allowedCommands);
      const maxAttempts = Math.min(Math.max(Number(args.maxAttempts ?? 2), 1), 5);
      const llm = context?.llm;
      const replan = llm
        ? async ({ attempt, maxAttempts: total, failure, verification: failedVerification, changes }) => {
            const response = await llm.complete({
              model: context.model,
              messages: [
                { role: 'system', content: DIAGNOSIS_SYSTEM },
                { role: 'user', content: JSON.stringify({ attempt, maxAttempts: total, failure, verification: failedVerification, changes }) },
              ],
              signal: context.signal,
            });
            let parsed;
            try {
              parsed = parseJsonObject(response?.text);
            } catch {
              return null;
            }
            try {
              return { operations: normalizeOperations(parsed.operations), verification: normalizeVerification(parsed.verification, allowedCommands) };
            } catch {
              return null;
            }
          }
        : undefined;

      const result = await engine.executeTransaction({ operations, verification, maxAttempts, replan });
      const diff = result.diff
        ? { ...result.diff, stdout: String(result.diff.stdout ?? '').slice(0, 200_000) }
        : result.diff;
      return {
        output: {
          state: result.state,
          attempts: result.attempts,
          changes: result.changes,
          verification: result.verification,
          failure: result.failure,
          rollback: result.rollback,
          evidenceDirectory: result.evidenceDirectory,
          diff,
        },
        ok: result.state === 'verified',
      };
    },
  };
}
