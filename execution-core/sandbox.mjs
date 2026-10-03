import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const SUPPORTED_LANGUAGES = Object.freeze({
  javascript: Object.freeze({ image: 'node:22-bookworm-slim', file: 'main.js', command: ['node', '/workspace/main.js'] }),
  typescript: Object.freeze({ image: 'node:22-bookworm-slim', file: 'main.ts', command: ['node', '--experimental-strip-types', '/workspace/main.ts'] }),
  python: Object.freeze({ image: 'python:3.12-slim', file: 'main.py', command: ['python', '/workspace/main.py'] }),
});

export const DEFAULT_SANDBOX_POLICY = Object.freeze({
  timeoutMs: 30_000,
  maxOutputBytes: 256_000,
  memoryMb: 512,
  cpus: 1,
  pidsLimit: 128,
  tmpfsSizeMb: 64,
  network: 'none',
  user: '65532:65532',
});

export class SandboxError extends Error {
  constructor(message, code = 'SANDBOX_ERROR', details = undefined) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Execute a controlled JavaScript snippet in a fresh VM context.
 * Node's vm is not a hostile-code security boundary; Docker/microVM remains
 * mandatory for untrusted production code. This runner is for bounded server
 * snippets and deterministic tests only.
 */
export async function runJavaScriptInVm({
  source,
  timeoutMs = 3_000,
  maxOutputBytes = 64_000,
  filename = 'sandbox.js',
  globals = {},
} = {}) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new SandboxError('source must be a non-empty string.', 'INVALID_SOURCE');
  }
  const timeout = bounded(timeoutMs, 3_000, 'timeoutMs', 5_000);
  const outputLimit = bounded(maxOutputBytes, 64_000, 'maxOutputBytes', 1_000_000);
  const logs = [];
  let outputBytes = 0;
  let outputTruncated = false;
  const started = Date.now();
  const timerHandles = new Set();
  const appendLog = (level, values) => {
    const message = values.map((value) => {
      try { return typeof value === 'string' ? value : JSON.stringify(value); }
      catch { return '[unserializable]'; }
    }).join(' ');
    const bytes = Buffer.byteLength(message, 'utf8');
    if (outputBytes + bytes > outputLimit) {
      outputTruncated = true;
      const remaining = Math.max(0, outputLimit - outputBytes);
      logs.push({ level, message: message.slice(0, remaining), at: new Date().toISOString() });
      outputBytes = outputLimit;
      return;
    }
    outputBytes += bytes;
    logs.push({ level, message, at: new Date().toISOString() });
  };
  const context = vm.createContext({
    ...globals,
    setTimeout: (callback, delay = 0, ...args) => {
      const handle = setTimeout(() => {
        timerHandles.delete(handle);
        callback(...args);
      }, Math.min(Math.max(Number(delay) || 0, 0), timeout));
      timerHandles.add(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      clearTimeout(handle);
      timerHandles.delete(handle);
    },
    console: Object.freeze({
      log: (...values) => appendLog('log', values),
      info: (...values) => appendLog('info', values),
      warn: (...values) => appendLog('warn', values),
      error: (...values) => appendLog('error', values),
    }),
  }, { name: 'semo0o-code-run' });
  let timer;
  try {
    const script = new vm.Script(`(async () => {\n${source}\n})()`, { filename });
    const execution = script.runInContext(context, { timeout });
    const result = await Promise.race([
      Promise.resolve(execution),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SandboxError('VM execution timed out.', 'VM_TIMEOUT')), timeout);
      }),
    ]);
    return { ok: !outputTruncated, result, logs, outputTruncated, durationMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      result: null,
      logs,
      outputTruncated,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      errorCode: error?.code ?? 'VM_EXECUTION_FAILED',
    };
  } finally {
    if (timer) clearTimeout(timer);
    for (const handle of timerHandles) clearTimeout(handle);
    timerHandles.clear();
  }
}

function positive(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new SandboxError(`${name} must be a positive integer.`, 'INVALID_SANDBOX_POLICY');
  }
  return resolved;
}

function bounded(value, fallback, name, maximum) {
  const resolved = positive(value, fallback, name);
  if (resolved > maximum) {
    throw new SandboxError(`${name} exceeds the safety maximum.`, 'SANDBOX_POLICY_TOO_LARGE');
  }
  return resolved;
}

export function validateCodeRunRequest(request = {}) {
  const language = request.language;
  const languageConfig = SUPPORTED_LANGUAGES[language];
  if (!languageConfig) {
    throw new SandboxError(`Unsupported language: ${String(language)}`, 'UNSUPPORTED_LANGUAGE');
  }
  if (typeof request.source !== 'string' || request.source.length === 0) {
    throw new SandboxError('source must be a non-empty string.', 'INVALID_SOURCE');
  }
  if (request.source.length > 2_000_000) {
    throw new SandboxError('source exceeds the maximum size.', 'SOURCE_TOO_LARGE');
  }
  if (request.command !== undefined && (!Array.isArray(request.command) || request.command.length === 0 || request.command.some((item) => typeof item !== 'string'))) {
    throw new SandboxError('command must be a non-empty string array.', 'INVALID_COMMAND');
  }
  const files = request.files ?? [];
  if (!Array.isArray(files) || files.some((file) => !file || typeof file.path !== 'string' || typeof file.content !== 'string')) {
    throw new SandboxError('files must contain path/content objects.', 'INVALID_FILES');
  }
  if (files.some((file) => path.posix.normalize(file.path) !== file.path || file.path.startsWith('/') || file.path.startsWith('../') || file.path.includes('/../'))) {
    throw new SandboxError('Sandbox files must use normalized relative paths.', 'INVALID_FILE_PATH');
  }
  return {
    language,
    source: request.source,
    files,
    command: request.command ?? languageConfig.command,
    timeoutMs: bounded(request.timeoutMs, DEFAULT_SANDBOX_POLICY.timeoutMs, 'timeoutMs', 120_000),
    maxOutputBytes: bounded(request.maxOutputBytes, DEFAULT_SANDBOX_POLICY.maxOutputBytes, 'maxOutputBytes', 2_000_000),
    memoryMb: bounded(request.memoryMb, DEFAULT_SANDBOX_POLICY.memoryMb, 'memoryMb', 2_048),
    cpus: typeof request.cpus === 'number' && request.cpus > 0 && request.cpus <= 4 ? request.cpus : DEFAULT_SANDBOX_POLICY.cpus,
    pidsLimit: bounded(request.pidsLimit, DEFAULT_SANDBOX_POLICY.pidsLimit, 'pidsLimit', 512),
    tmpfsSizeMb: bounded(request.tmpfsSizeMb, DEFAULT_SANDBOX_POLICY.tmpfsSizeMb, 'tmpfsSizeMb', 256),
    network: request.network === 'none' || request.network === undefined ? 'none' : (() => { throw new SandboxError('Only network=none is supported by the default runner.', 'NETWORK_POLICY_UNSUPPORTED'); })(),
    user: DEFAULT_SANDBOX_POLICY.user,
  };
}

export function buildDockerInvocation(request, workspacePath, imageOverride) {
  const normalized = validateCodeRunRequest(request);
  const image = imageOverride ?? SUPPORTED_LANGUAGES[normalized.language].image;
  if (typeof image !== 'string' || !/^[a-zA-Z0-9./:_-]+$/.test(image)) {
    throw new SandboxError('Invalid sandbox image.', 'INVALID_IMAGE');
  }
  const args = [
    'run', '--rm', '--init',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--user=${normalized.user}`,
    `--memory=${normalized.memoryMb}m`,
    `--cpus=${normalized.cpus}`,
    `--pids-limit=${normalized.pidsLimit}`,
    `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${normalized.tmpfsSizeMb}m`,
    '--mount', `type=bind,src=${workspacePath},dst=/workspace,rw,readonly=false`,
    '--workdir=/workspace',
    image,
    ...normalized.command,
  ];
  return { args, request: normalized, image };
}

function appendOutput(state, chunk, maxBytes) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = maxBytes - state.total;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }
  const clipped = bytes.subarray(0, remaining);
  state.total += clipped.length;
  if (clipped.length !== bytes.length) state.truncated = true;
  state.value = Buffer.concat([state.value, clipped]);
}

export class DockerSandboxRunner {
  constructor({ docker = 'docker', spawnImpl = spawn, tempRoot = os.tmpdir(), onEvidence } = {}) {
    this.docker = docker;
    this.spawnImpl = spawnImpl;
    this.tempRoot = tempRoot;
    this.onEvidence = onEvidence;
  }

  async run(request = {}) {
    const built = buildDockerInvocation(request, '<workspace>');
    const workspace = await mkdtemp(path.join(this.tempRoot, 'semo0o-sandbox-'));
    const started = Date.now();
    const runId = randomUUID();
    try {
      await writeFile(path.join(workspace, built.request.language === 'javascript' ? 'main.js' : built.request.language === 'typescript' ? 'main.ts' : 'main.py'), built.request.source, 'utf8');
      for (const file of built.request.files) {
        const target = path.join(workspace, file.path);
        const parent = path.dirname(target);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(parent, { recursive: true });
        await writeFile(target, file.content, 'utf8');
      }
      const invocation = buildDockerInvocation(built.request, workspace, built.image);
      const result = await this.#spawn(invocation.args, built.request);
      const evidence = {
        runId,
        language: built.request.language,
        image: built.image,
        isolated: true,
        network: 'none',
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: Date.now() - started,
        timedOut: result.timedOut,
        outputTruncated: result.outputTruncated,
        ok: result.exitCode === 0 && !result.timedOut && !result.outputTruncated && !result.spawnFailure,
      };
      await this.onEvidence?.(evidence);
      return evidence;
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  #spawn(args, request) {
    return new Promise((resolve) => {
      const stdout = { value: Buffer.alloc(0), total: 0, truncated: false };
      const stderr = { value: Buffer.alloc(0), total: 0, truncated: false };
      let timedOut = false;
      let spawnFailure;
      const child = this.spawnImpl(this.docker, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', (chunk) => appendOutput(stdout, chunk, request.maxOutputBytes));
      child.stderr?.on('data', (chunk) => appendOutput(stderr, chunk, request.maxOutputBytes));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill?.('SIGKILL');
      }, request.timeoutMs);
      child.once('error', (error) => { spawnFailure = error instanceof Error ? error.message : String(error); });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          exitCode,
          signal,
          timedOut,
          outputTruncated: stdout.truncated || stderr.truncated,
          stdout: stdout.value.toString('utf8'),
          stderr: stderr.value.toString('utf8'),
          spawnFailure,
        });
      });
    });
  }
}
