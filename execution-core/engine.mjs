import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Real, Node-hosted execution runtime for a single checked-out workspace.
 *
 * This module deliberately has no React Native imports. A mobile/web client must
 * invoke it through an authenticated backend or local runner; it must never try
 * to execute shell commands in the browser.
 */

export const Capability = Object.freeze({
  FILE_READ: 'workspace.read',
  FILE_WRITE: 'workspace.write',
  TERMINAL_EXECUTE: 'terminal.execute',
  GIT_READ: 'git.read',
  GIT_WRITE: 'git.write',
  NETWORK: 'network.access',
});

export const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 120_000,
  maxOutputBytes: 1_000_000,
  // A high but finite address-space limit keeps normal Node/Expo processes viable.
  memoryLimitMb: 8_192,
  cpuLimitSeconds: 120,
});

const DEFAULT_COMMANDS = new Set(['git', 'node', 'npm', 'npx']);

// Directory (relative to the workspace root) that holds run evidence. Every run
// gets its own timestamped sub-directory, so the whole container is excluded
// from checkpoints to keep evidence out of commits across runs.
const EVIDENCE_CONTAINER = '.semo0o-evidence';

// Deterministic author/committer identity for automated checkpoints. The sandbox
// pins HOME inside the workspace (buildSandboxEnv), so a fresh task checkout has
// no global gitconfig; when Git auto-detection is disabled (`user.useConfigOnly`)
// a bare `git commit` fails with "Author identity unknown" (exit 128). Supplying
// the identity explicitly keeps the checkpoint self-sufficient and reproducible.
const CHECKPOINT_IDENTITY = Object.freeze({
  name: 'semo0o-agent',
  email: 'semo0o-agent@users.noreply.github.com',
});

// Environment variables that are safe to forward to sandboxed child processes.
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM'];
// Names that must never reach a child process: they either let an attacker inject
// code (NODE_OPTIONS, LD_PRELOAD, GIT_SSH_COMMAND, ...) or leak server secrets.
const ENV_DENYLIST = /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]+|BASH_ENV|ENV|SHELLOPTS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_EXTERNAL_DIFF|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|SECRETS_MASTER_KEY|DATABASE_FILE|DATABASE_URL|[A-Z0-9_]*_API_KEY|[A-Z0-9_]*_SECRET|[A-Z0-9_]*_TOKEN|[A-Z0-9_]*_PASSWORD|[A-Z0-9_]*_CREDENTIALS)$/i;

/**
 * Build a minimal, secret-free environment for a sandboxed child process. The
 * server's full environment (which holds SECRETS_MASTER_KEY, provider API keys,
 * database paths, ...) is deliberately NOT inherited.
 */
function buildSandboxEnv(root, requested = {}) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = root;
  env.TMPDIR = path.join(root, '.tmp');
  env.NODE_ENV = 'production';
  if (requested && typeof requested === 'object') {
    for (const [key, value] of Object.entries(requested)) {
      if (typeof key !== 'string' || typeof value !== 'string') continue;
      if (ENV_DENYLIST.test(key)) continue;
      env[key] = value;
    }
  }
  return env;
}

export class ExecutionError extends Error {
  constructor(message, code = 'EXECUTION_ERROR', details = undefined) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
    this.details = details;
  }
}

export class PermissionDeniedError extends ExecutionError {
  constructor(capability, details) {
    super(`Permission denied for ${capability}.`, 'PERMISSION_DENIED', { capability, ...details });
    this.name = 'PermissionDeniedError';
  }
}

function now() {
  return new Date().toISOString();
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ensurePositiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new ExecutionError(`${name} must be a positive integer.`, 'INVALID_LIMIT');
  }
  return resolved;
}

function normalizeRelativePath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ExecutionError('A non-empty workspace-relative path is required.', 'INVALID_PATH');
  }

  const replaced = input.replaceAll('\\', '/').trim();
  if (replaced.startsWith('/') || replaced.startsWith('~') || /^[A-Za-z]:\//.test(replaced)) {
    throw new ExecutionError('Absolute paths are forbidden.', 'PATH_OUTSIDE_WORKSPACE');
  }

  const normalized = path.posix.normalize(replaced);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new ExecutionError('Path traversal outside the workspace is forbidden.', 'PATH_OUTSIDE_WORKSPACE');
  }
  return normalized;
}

// Branches that represent the shared, protected integration line. Task work must
// never be written directly to them; a dedicated task branch is created instead.
const DEFAULT_BRANCHES = new Set(['master', 'main']);

/** True when a branch name is the protected default/integration branch. */
export function isDefaultBranch(name) {
  return DEFAULT_BRANCHES.has(String(name ?? '').trim().toLowerCase());
}

function validateBranchName(name) {
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
    throw new ExecutionError('A branch name between 1 and 200 characters is required.', 'INVALID_BRANCH');
  }
  const branch = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) {
    throw new ExecutionError('Branch name contains characters that are not allowed.', 'INVALID_BRANCH', { branch });
  }
  if (
    branch.includes('..') ||
    branch.includes('//') ||
    branch.includes('@{') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock')
  ) {
    throw new ExecutionError('Branch name is not a valid Git reference.', 'INVALID_BRANCH', { branch });
  }
  return branch;
}

function validateRevision(revision) {
  if (typeof revision !== 'string' || !/^[A-Za-z0-9._/-]{1,255}$/.test(revision)) {
    throw new ExecutionError('Invalid Git revision.', 'INVALID_REVISION');
  }
  return revision;
}

// A push target is a *named* remote (e.g. `origin`), never a raw URL: the remote
// is configured by the operator when the task workspace is provisioned, so the
// agent can never be tricked into pushing to an attacker-controlled endpoint.
function validateRemoteName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name.trim())) {
    throw new ExecutionError('A valid Git remote name is required.', 'INVALID_REMOTE_NAME');
  }
  return name.trim();
}

function isNetworkRemoteUrl(url) {
  return /^(https?:|git@|ssh:|git:\/\/)/i.test(String(url ?? '').trim());
}

function commandSummary(command, args) {
  return [command, ...args].join(' ');
}

function truncateAppend(current, chunk, remaining) {
  if (remaining <= 0) return current;
  const limited = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
  return Buffer.concat([current, limited]);
}

/**
 * Default-deny permission gateway. A caller may grant capabilities up front or
 * supply an approval callback that receives every requested capability.
 */
export class PermissionGateway {
  constructor({ grants = [], requestApproval } = {}) {
    this.grants = new Set(grants);
    this.requestApproval = requestApproval;
    this.audit = [];
  }

  grant(...capabilities) {
    capabilities.flat().forEach((capability) => this.grants.add(capability));
  }

  revoke(...capabilities) {
    capabilities.flat().forEach((capability) => this.grants.delete(capability));
  }

  async require(capability, details = {}) {
    let allowed = this.grants.has(capability);
    let source = allowed ? 'grant' : 'denied';

    if (!allowed && this.requestApproval) {
      const decision = await this.requestApproval({ capability, ...details });
      allowed = decision === true || decision?.allow === true;
      source = allowed ? 'approval' : 'denied';
      if (allowed && decision?.remember) this.grants.add(capability);
    }

    this.audit.push({ at: now(), capability, allowed, source, details });
    if (!allowed) throw new PermissionDeniedError(capability, details);
  }
}

/** Persists bounded command logs, results, and a chronological event manifest. */
export class EvidenceStore {
  constructor(directory, runId = randomUUID()) {
    this.directory = directory;
    this.runId = runId;
    this.events = [];
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await fs.mkdir(this.directory, { recursive: true });
    this.initialized = true;
    await this.record('run_started', { runId: this.runId, platform: process.platform, node: process.version });
  }

  async record(type, details = {}) {
    if (!this.initialized) await this.initialize();
    this.events.push({ at: now(), type, details });
    await fs.writeFile(
      path.join(this.directory, 'manifest.json'),
      JSON.stringify({ runId: this.runId, updatedAt: now(), events: this.events }, null, 2),
      'utf8',
    );
  }

  async writeJson(filename, value) {
    if (!this.initialized) await this.initialize();
    const safeName = path.basename(filename);
    await fs.writeFile(path.join(this.directory, safeName), JSON.stringify(value, null, 2), 'utf8');
  }

  async writeText(filename, value) {
    if (!this.initialized) await this.initialize();
    const safeName = path.basename(filename);
    await fs.writeFile(path.join(this.directory, safeName), value, 'utf8');
  }
}

/**
 * Physical file engine. All paths are workspace-relative, parent symlinks are
 * rejected, writes are atomic, and no operation may escape the chosen root.
 */
export class RealWorkspace {
  constructor(root, permissions, evidence) {
    this.requestedRoot = root;
    this.permissions = permissions;
    this.evidence = evidence;
    this.root = undefined;
  }

  async initialize() {
    const real = await fs.realpath(this.requestedRoot);
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new ExecutionError('Workspace root must be a directory.', 'INVALID_WORKSPACE');
    this.root = real;
    await this.evidence.record('workspace_initialized', { root: this.root });
    return this;
  }

  async read(relativePath, { maxBytes = 2_000_000 } = {}) {
    await this.permissions.require(Capability.FILE_READ, { operation: 'read', path: relativePath });
    const target = await this.#resolveExisting(relativePath);
    const stat = await fs.lstat(target);
    if (!stat.isFile()) throw new ExecutionError('Only regular files can be read.', 'NOT_A_FILE');
    if (stat.size > maxBytes) {
      throw new ExecutionError(`File exceeds the ${maxBytes}-byte read limit.`, 'FILE_TOO_LARGE');
    }
    const content = await fs.readFile(target, 'utf8');
    const result = { path: normalizeRelativePath(relativePath), content, bytes: stat.size, sha256: digest(content) };
    await this.evidence.record('file_read', { path: result.path, bytes: result.bytes, sha256: result.sha256 });
    return result;
  }

  async write(relativePath, content) {
    await this.permissions.require(Capability.FILE_WRITE, { operation: 'write', path: relativePath });
    if (typeof content !== 'string') throw new ExecutionError('File content must be a string.', 'INVALID_CONTENT');
    const { normalized, target } = await this.#resolveWritable(relativePath);
    const existed = await pathExists(target);
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.semo0o-${randomUUID()}.tmp`);
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, target);
    const result = { path: normalized, created: !existed, bytes: Buffer.byteLength(content), sha256: digest(content) };
    await this.evidence.record('file_written', result);
    return result;
  }

  async patch(relativePath, expected, replacement) {
    await this.permissions.require(Capability.FILE_WRITE, { operation: 'patch', path: relativePath });
    if (typeof expected !== 'string' || typeof replacement !== 'string') {
      throw new ExecutionError('Patch expected and replacement values must be strings.', 'INVALID_PATCH');
    }
    const current = await this.read(relativePath);
    if (current.content !== expected) {
      throw new ExecutionError('Safe patch rejected because the file changed since inspection.', 'PATCH_CONFLICT', {
        path: current.path,
        expectedSha256: digest(expected),
        actualSha256: current.sha256,
      });
    }
    const written = await this.write(relativePath, replacement);
    await this.evidence.record('safe_patch_applied', {
      path: written.path,
      beforeSha256: current.sha256,
      afterSha256: written.sha256,
    });
    return written;
  }

  async delete(relativePath) {
    await this.permissions.require(Capability.FILE_WRITE, { operation: 'delete', path: relativePath });
    const normalized = normalizeRelativePath(relativePath);
    const target = await this.#target(normalized);
    try {
      await this.#assertNoSymlinks(normalized, false);
      const stat = await fs.lstat(target);
      if (!stat.isFile()) throw new ExecutionError('Only regular files can be deleted.', 'NOT_A_FILE');
      await fs.unlink(target);
      await this.evidence.record('file_deleted', { path: normalized, bytes: stat.size });
      return { path: normalized, deleted: true };
    } catch (error) {
      if (error?.code === 'ENOENT') return { path: normalized, deleted: false };
      throw error;
    }
  }

  async exists(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const target = await this.#target(normalized);
    try {
      await this.#assertNoSymlinks(normalized, false);
      const stat = await fs.lstat(target);
      return stat.isFile();
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Bounded, permission-gated directory listing. It never follows symlinks and
   * skips heavy/generated directories, so a scan can neither walk out of the
   * workspace nor exhaust memory. Paths are always workspace-relative.
   */
  async list({ scope = '.', maxFiles = 500, maxDepth = 32 } = {}) {
    await this.permissions.require(Capability.FILE_READ, { operation: 'list', path: scope });
    if (!this.root) throw new ExecutionError('Workspace is not initialized.', 'NOT_INITIALIZED');
    const limit = ensurePositiveInteger(maxFiles, 500, 'maxFiles');
    if (limit > 5_000) throw new ExecutionError('maxFiles exceeds the safe boundary.', 'INVALID_LIMIT');
    const depthLimit = ensurePositiveInteger(maxDepth, 32, 'maxDepth');
    if (depthLimit > 128) throw new ExecutionError('maxDepth exceeds the safe boundary.', 'INVALID_LIMIT');

    const normalizedScope = scope === undefined || scope === '' || scope === '.' ? '' : normalizeRelativePath(scope);
    let start = this.root;
    if (normalizedScope !== '') {
      start = await this.#resolveExisting(normalizedScope);
      const scopeStat = await fs.lstat(start);
      if (scopeStat.isSymbolicLink()) throw new ExecutionError('Symlink traversal is forbidden.', 'SYMLINK_FORBIDDEN');
      if (!scopeStat.isDirectory()) throw new ExecutionError('Only directories can be listed.', 'NOT_A_DIRECTORY');
    }

    const skipped = new Set(['node_modules', '.git', '.expo', EVIDENCE_CONTAINER]);
    const files = [];
    let truncated = false;
    const visit = async (dir, relative, depth) => {
      if (files.length >= limit) {
        truncated = true;
        return;
      }
      if (depth > depthLimit) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        if (skipped.has(entry.name)) continue;
        if (entry.isSymbolicLink()) continue; // never follow symlinks out of the workspace
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await visit(path.join(dir, entry.name), nextRelative, depth + 1);
        } else if (entry.isFile()) {
          const info = await fs.lstat(path.join(dir, entry.name));
          files.push({ path: nextRelative, sizeBytes: info.size });
        }
      }
    };
    await visit(start, normalizedScope, 0);

    const result = { scope: normalizedScope || '.', files, truncated };
    await this.evidence.record('workspace_listed', { scope: result.scope, files: files.length, truncated });
    return result;
  }

  async #target(normalized) {
    if (!this.root) throw new ExecutionError('Workspace is not initialized.', 'NOT_INITIALIZED');
    const target = path.resolve(this.root, ...normalized.split('/'));
    if (!isInside(this.root, target)) throw new ExecutionError('Path escapes the workspace.', 'PATH_OUTSIDE_WORKSPACE');
    return target;
  }

  async #resolveExisting(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const target = await this.#target(normalized);
    await this.#assertNoSymlinks(normalized, false);
    return target;
  }

  async #resolveWritable(relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const target = await this.#target(normalized);
    const parts = normalized.split('/');
    let current = this.root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = path.join(current, parts[index]);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new ExecutionError('Symlink traversal is forbidden.', 'SYMLINK_FORBIDDEN');
        if (!stat.isDirectory()) throw new ExecutionError('A parent path is not a directory.', 'INVALID_PARENT');
      } catch (error) {
        if (error?.code === 'ENOENT') await fs.mkdir(current);
        else throw error;
      }
    }
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new ExecutionError('Writing through a symlink is forbidden.', 'SYMLINK_FORBIDDEN');
      if (stat.isDirectory()) throw new ExecutionError('Cannot write a directory as a file.', 'NOT_A_FILE');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return { normalized, target };
  }

  async #assertNoSymlinks(normalized, includeLeaf) {
    const parts = normalized.split('/');
    const last = includeLeaf ? parts.length : parts.length - 1;
    let current = this.root;
    for (let index = 0; index < last; index += 1) {
      current = path.join(current, parts[index]);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new ExecutionError('Symlink traversal is forbidden.', 'SYMLINK_FORBIDDEN');
      if (index < last - 1 && !stat.isDirectory()) throw new ExecutionError('A parent path is not a directory.', 'INVALID_PARENT');
    }
  }
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function hasPrlimit() {
  return process.platform === 'linux' && (await pathExists('/usr/bin/prlimit'));
}

function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * Terminal runner with no shell interpolation. It accepts a program plus an
 * argument array, enforces allow-list, timeout, output cap, and (on Linux)
 * kernel CPU/address-space limits through prlimit.
 */
export class TerminalSandbox {
  constructor({ root, permissions, evidence, limits = {}, allowedCommands = DEFAULT_COMMANDS }) {
    this.root = root;
    this.permissions = permissions;
    this.evidence = evidence;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.allowedCommands = new Set(allowedCommands);
  }

  async run(request) {
    const command = request?.command;
    const args = request?.args ?? [];
    const capability = request?.permission ?? Capability.TERMINAL_EXECUTE;
    if (typeof command !== 'string' || !this.allowedCommands.has(command)) {
      throw new ExecutionError(`Command is not allow-listed: ${command}`, 'COMMAND_NOT_ALLOWED');
    }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
      throw new ExecutionError('Command arguments must be a string array.', 'INVALID_COMMAND');
    }
    if (args.some((arg) => arg.includes('\u0000')) || args.length > 80) {
      throw new ExecutionError('Command arguments exceed the safe boundary.', 'INVALID_COMMAND');
    }

    await this.permissions.require(capability, { operation: 'execute', command, args });
    if (request?.needsNetwork) {
      await this.permissions.require(Capability.NETWORK, { operation: 'network', command, args });
    }

    const timeoutMs = ensurePositiveInteger(request?.timeoutMs, this.limits.timeoutMs, 'timeoutMs');
    const maxOutputBytes = ensurePositiveInteger(request?.maxOutputBytes, this.limits.maxOutputBytes, 'maxOutputBytes');
    const memoryLimitMb = ensurePositiveInteger(request?.memoryLimitMb, this.limits.memoryLimitMb, 'memoryLimitMb');
    const cpuLimitSeconds = ensurePositiveInteger(request?.cpuLimitSeconds, this.limits.cpuLimitSeconds, 'cpuLimitSeconds');
    const startedAt = now();
    const started = Date.now();
    // Keep child temp files inside the workspace sandbox.
    await fs.mkdir(path.join(this.root, '.tmp'), { recursive: true }).catch(() => {});

    let executable = command;
    let spawnArgs = [...args];
    const resourceLimits = { timeout: true, output: true, memory: false, cpu: false };
    if (await hasPrlimit()) {
      executable = '/usr/bin/prlimit';
      spawnArgs = [
        `--as=${memoryLimitMb * 1024 * 1024}`,
        `--cpu=${cpuLimitSeconds}`,
        '--',
        command,
        ...args,
      ];
      resourceLimits.memory = true;
      resourceLimits.cpu = true;
    }

    const result = await new Promise((resolve) => {
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let totalOutput = 0;
      let outputTruncated = false;
      let timedOut = false;
      let spawnFailure;
      const child = spawn(executable, spawnArgs, {
        cwd: this.root,
        detached: process.platform !== 'win32',
        // Never inherit the server's environment: it holds SECRETS_MASTER_KEY,
        // provider API keys, and database paths. buildSandboxEnv forwards only an
        // allow-list (PATH/LANG/...), pins HOME/TMPDIR inside the workspace, and
        // drops anything matching ENV_DENYLIST.
        env: buildSandboxEnv(this.root, request?.env ?? {}),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const append = (which, chunk) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = maxOutputBytes - totalOutput;
        if (remaining <= 0) {
          outputTruncated = true;
          return;
        }
        const clipped = value.subarray(0, remaining);
        totalOutput += clipped.length;
        if (clipped.length !== value.length) outputTruncated = true;
        if (which === 'stdout') stdout = truncateAppend(stdout, clipped, remaining);
        else stderr = truncateAppend(stderr, clipped, remaining);
      };

      child.stdout.on('data', (chunk) => append('stdout', chunk));
      child.stderr.on('data', (chunk) => append('stderr', chunk));
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);

      child.once('error', (error) => {
        spawnFailure = errorMessage(error);
      });
      child.once('close', (exitCode, signal) => {
        clearTimeout(timer);
        resolve({
          command,
          args,
          displayCommand: commandSummary(command, args),
          startedAt,
          finishedAt: now(),
          durationMs: Date.now() - started,
          exitCode,
          signal,
          timedOut,
          outputTruncated,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          resourceLimits,
          spawnFailure,
          ok: exitCode === 0 && !timedOut && !outputTruncated && !spawnFailure,
        });
      });
    });

    await this.evidence.record('terminal_completed', result);
    return result;
  }
}

/** Git operations are routed through the same bounded terminal and distinct permissions. */
export class RealGit {
  constructor(terminal, evidence, { exclude = [] } = {}) {
    this.terminal = terminal;
    this.evidence = evidence;
    // Workspace-relative paths that must never be committed (run evidence, scratch).
    this.exclude = [...new Set(exclude.filter((entry) => typeof entry === 'string' && entry.length > 0))];
  }

  async status() {
    const result = await this.#run(['status', '--porcelain=v1', '--branch'], Capability.GIT_READ);
    return { ...result, entries: result.stdout.split('\n').filter(Boolean) };
  }

  async diff() {
    return this.#run(['diff', '--no-ext-diff', '--binary', '--'], Capability.GIT_READ, { maxOutputBytes: 2_000_000 });
  }

  async branch() {
    const result = await this.#run(['branch', '--show-current'], Capability.GIT_READ);
    return { ...result, branch: result.stdout.trim() };
  }

  /**
   * Bounded, read-only commit history. An explicit tab separator keeps the parse
   * unambiguous regardless of the commit subject content.
   */
  async log({ limit = 20, ref } = {}) {
    const count = Number.isInteger(Number(limit)) ? Math.min(Math.max(Number(limit), 1), 200) : 20;
    const args = ['log', `--max-count=${count}`, '--pretty=format:%H%x09%an%x09%aI%x09%s'];
    if (ref) args.push(validateRevision(ref));
    const result = await this.#run(args, Capability.GIT_READ, { maxOutputBytes: 1_000_000 });
    const entries = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, author, date, ...rest] = line.split('\t');
        return { sha, author, date, subject: rest.join('\t') };
      });
    return { ...result, entries };
  }

  async listBranches() {
    const result = await this.#run(['branch', '--format=%(refname:short)'], Capability.GIT_READ);
    return { ...result, branches: result.stdout.split('\n').map((line) => line.trim()).filter(Boolean) };
  }

  isDefaultBranch(name) {
    return isDefaultBranch(name);
  }

  /** Initialise a fresh repository inside the workspace (used when no remote is given). */
  async init({ branch } = {}) {
    const args = ['init'];
    if (branch) args.push(`--initial-branch=${validateBranchName(branch)}`);
    const result = await this.#run(args, Capability.GIT_WRITE);
    if (!result.ok) throw new ExecutionError('Unable to initialise the repository.', 'GIT_INIT_FAILED', result);
    await this.evidence.record('git_initialized', { branch: branch ?? null });
    return { ...result, initialized: true };
  }

  /**
   * Clone a repository into a workspace-relative destination. Remote URLs require
   * the network capability; a local path does not. This is the real Git checkout
   * the lifecycle needs (status/diff/branch), unlike a file-only import.
   */
  async clone(url, { dest = '.', ref, depth, needsNetwork } = {}) {
    if (typeof url !== 'string' || url.trim().length === 0 || url.length > 2048 || url.includes('\u0000')) {
      throw new ExecutionError('A valid repository URL or path is required.', 'INVALID_REMOTE');
    }
    const target = normalizeRelativePath(dest === '' ? '.' : dest);
    const args = ['clone'];
    if (depth) args.push('--depth', String(ensurePositiveInteger(depth, 1, 'depth')));
    if (ref) args.push('--branch', validateRevision(ref));
    args.push('--', url.trim(), target);
    const remote = /^(https?:|git@|ssh:|git:\/\/)/i.test(url.trim());
    const result = await this.#run(args, Capability.GIT_WRITE, {
      needsNetwork: needsNetwork ?? remote,
      timeoutMs: 300_000,
      maxOutputBytes: 2_000_000,
    });
    if (!result.ok) throw new ExecutionError('Git clone failed.', 'GIT_CLONE_FAILED', result);
    await this.evidence.record('git_cloned', { url: url.trim(), dest: target, ref: ref ?? null, remote });
    return { ...result, url: url.trim(), dest: target, ref: ref ?? null, remote };
  }

  /**
   * Create (or check out) an independent task branch. Creating the protected
   * default branch is refused so the integration line is never written to.
   */
  async createBranch(name, { from } = {}) {
    const branch = validateBranchName(name);
    if (isDefaultBranch(branch)) {
      throw new ExecutionError(
        'Refusing to create the protected default branch; task work must use a dedicated branch.',
        'DEFAULT_BRANCH_FORBIDDEN',
        { branch },
      );
    }
    const base = from ? validateRevision(from) : undefined;

    // A freshly initialised repository has an "unborn" branch with no ref, so an
    // existence check must also consider the current symbolic HEAD.
    const current = await this.#run(['symbolic-ref', '--quiet', 'HEAD'], Capability.GIT_READ);
    const currentBranch = current.ok ? current.stdout.trim().replace(/^refs\/heads\//, '') : '';
    if (currentBranch === branch) {
      await this.evidence.record('git_branch_ready', { branch, from: base ?? 'HEAD', created: false, current: true });
      return { ok: true, branch, from: base ?? 'HEAD', created: false, alreadyOn: true };
    }

    const exists = await this.#run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], Capability.GIT_READ);
    const args = exists.ok ? ['checkout', branch] : ['checkout', '-b', branch, ...(base ? [base] : [])];
    const result = await this.#run(args, Capability.GIT_WRITE);
    if (!result.ok) throw new ExecutionError('Unable to create or check out the task branch.', 'GIT_BRANCH_FAILED', result);
    await this.evidence.record('git_branch_ready', { branch, from: base ?? 'HEAD', created: !exists.ok });
    return { ...result, branch, from: base ?? 'HEAD', created: !exists.ok };
  }

  /** True when a `git status --porcelain` entry points at an excluded path. */
  #isExcludedEntry(entry) {
    const raw = String(entry).slice(3).trim();
    if (!raw) return false;
    // Renames are reported as "old -> new"; the destination is what matters.
    const target = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw;
    const normalized = target.replace(/^"|"$/g, '');
    return this.exclude.some((ex) => normalized === ex || normalized.startsWith(`${ex}/`));
  }

  /** Real, committable changes only (excluded scratch/evidence never counts). */
  #changedEntries(status) {
    return (status?.entries ?? []).filter((entry) => !String(entry).startsWith('##') && !this.#isExcludedEntry(entry));
  }

  /** Public view of the real, committable changes (excludes scratch/evidence). */
  async changedEntries() {
    const status = await this.status();
    return { status, entries: this.#changedEntries(status) };
  }

  async checkpoint(message) {
    if (typeof message !== 'string' || message.trim().length < 3 || message.length > 240) {
      throw new ExecutionError('Checkpoint message must be between 3 and 240 characters.', 'INVALID_CHECKPOINT');
    }
    const before = await this.status();
    const changed = this.#changedEntries(before);
    if (changed.length === 0) return { created: false, reason: 'clean_worktree', status: before };

    const add = await this.#run(['add', '--all', '--', '.', ...this.exclude.map((entry) => `:(exclude)${entry}`)], Capability.GIT_WRITE);
    if (!add.ok) throw new ExecutionError('Unable to stage checkpoint changes.', 'GIT_ADD_FAILED', add);
    // Supply the checkpoint identity explicitly (`-c` must precede the subcommand)
    // so the commit never depends on an ambient global gitconfig or on Git's
    // host-based auto-detection, both of which are absent inside the sandbox.
    const commit = await this.#run(
      [
        '-c',
        `user.name=${CHECKPOINT_IDENTITY.name}`,
        '-c',
        `user.email=${CHECKPOINT_IDENTITY.email}`,
        'commit',
        '--no-gpg-sign',
        '-m',
        message.trim(),
      ],
      Capability.GIT_WRITE,
    );
    if (!commit.ok) throw new ExecutionError('Unable to create checkpoint commit.', 'GIT_COMMIT_FAILED', commit);
    const revision = await this.#run(['rev-parse', 'HEAD'], Capability.GIT_READ);
    const result = { created: true, revision: revision.stdout.trim(), author: { ...CHECKPOINT_IDENTITY }, commit };
    await this.evidence.record('git_checkpoint', result);
    return result;
  }

  async rollback(revision) {
    const target = validateRevision(revision);
    // Deliberately does not call git clean: untracked user files must never be deleted implicitly.
    const result = await this.#run(['reset', '--hard', target], Capability.GIT_WRITE);
    if (!result.ok) throw new ExecutionError('Git rollback failed.', 'GIT_ROLLBACK_FAILED', result);
    await this.evidence.record('git_rollback', { revision: target, result });
    return result;
  }

  /** Resolve whether a named remote points at a network URL (needs NETWORK). */
  async #remoteIsNetwork(name) {
    const result = await this.#run(['remote', 'get-url', name], Capability.GIT_READ);
    // An unknown remote is treated as network so the stricter capability applies.
    if (!result.ok) return true;
    return isNetworkRemoteUrl(result.stdout);
  }

  /**
   * Push the current (or named) branch to a configured remote. Pushing the
   * protected default branch is refused: agent work must always travel through a
   * dedicated task branch and a pull request, never by writing the integration
   * line directly. `--force-with-lease` is used when forcing so a concurrent
   * update to the remote is never silently overwritten.
   */
  async push(remote = 'origin', branch, { setUpstream = true, force = false, needsNetwork } = {}) {
    const remoteName = validateRemoteName(remote);
    const target = branch ? validateBranchName(branch) : (await this.branch()).branch;
    if (!target) throw new ExecutionError('No branch to push; the repository has no current branch.', 'GIT_PUSH_NO_BRANCH');
    if (isDefaultBranch(target)) {
      throw new ExecutionError(
        'Refusing to push the protected default branch; push a task branch and open a pull request.',
        'DEFAULT_BRANCH_FORBIDDEN',
        { branch: target },
      );
    }
    const args = ['push'];
    if (force) args.push('--force-with-lease');
    if (setUpstream) args.push('--set-upstream');
    args.push(remoteName, `${target}:${target}`);
    const network = needsNetwork ?? (await this.#remoteIsNetwork(remoteName));
    const result = await this.#run(args, Capability.GIT_WRITE, {
      needsNetwork: network,
      timeoutMs: 180_000,
      maxOutputBytes: 500_000,
    });
    if (!result.ok) throw new ExecutionError('Git push failed.', 'GIT_PUSH_FAILED', result);
    await this.evidence.record('git_pushed', { remote: remoteName, branch: target, force, network });
    return { ...result, remote: remoteName, branch: target, pushed: true };
  }

  async #run(args, permission, options = {}) {
    const result = await this.terminal.run({ command: 'git', args, permission, ...options });
    await this.evidence.record('git_command', { args, ok: result.ok, exitCode: result.exitCode });
    return result;
  }
}

function analyseFailure(verification) {
  const failed = verification.find((item) => !item.ok);
  if (!failed) return { kind: 'unknown', summary: 'Verification did not produce a usable result.' };
  const combined = `${failed.stderr}\n${failed.stdout}`.toLowerCase();
  if (failed.timedOut) return { kind: 'timeout', summary: `Command timed out: ${failed.displayCommand}` };
  if (failed.outputTruncated) return { kind: 'incomplete_evidence', summary: `Command output exceeded the evidence limit: ${failed.displayCommand}` };
  if (combined.includes('missing script')) return { kind: 'missing_script', summary: `Required npm script is missing: ${failed.displayCommand}` };
  if (combined.includes('out of memory') || combined.includes('heap out of memory')) {
    return { kind: 'resource_limit', summary: `Command exhausted memory: ${failed.displayCommand}` };
  }
  return { kind: 'command_failed', summary: `Verification failed: ${failed.displayCommand}`, exitCode: failed.exitCode };
}

/**
 * Applies file operations transactionally, verifies them with real commands,
 * retains bounded evidence, and restores only agent-touched files on failure.
 */
export class AgentExecutionEngine {
  constructor({ workspacePath, grants = [], requestApproval, evidenceDirectory, limits, allowedCommands } = {}) {
    if (!workspacePath) throw new ExecutionError('workspacePath is required.', 'INVALID_WORKSPACE');
    this.permissions = new PermissionGateway({ grants, requestApproval });
    this.evidence = new EvidenceStore(
      evidenceDirectory ?? path.join(workspacePath, EVIDENCE_CONTAINER, randomUUID()),
    );
    this.files = new RealWorkspace(workspacePath, this.permissions, this.evidence);
    this.limits = limits;
    this.allowedCommands = allowedCommands;
    this.terminal = undefined;
    this.git = undefined;
  }

  async initialize() {
    await this.evidence.initialize();
    await this.files.initialize();
    this.terminal = new TerminalSandbox({
      root: this.files.root,
      permissions: this.permissions,
      evidence: this.evidence,
      limits: this.limits,
      allowedCommands: this.allowedCommands,
    });
    // Never let run evidence or scratch files be committed by a checkpoint.
    const excludes = ['.tmp'];
    const relativeEvidence = path.relative(this.files.root, this.evidence.directory);
    if (relativeEvidence && !relativeEvidence.startsWith('..') && !path.isAbsolute(relativeEvidence)) {
      const normalized = relativeEvidence.split(path.sep).join('/');
      excludes.push(normalized);
      // Evidence runs live under a shared container (default .semo0o-evidence/<run>).
      // Exclude the whole container so evidence from earlier runs is never staged.
      const [container] = normalized.split('/');
      if (container === EVIDENCE_CONTAINER && container !== normalized) excludes.push(container);
    }
    this.git = new RealGit(this.terminal, this.evidence, { exclude: excludes });
    return this;
  }

  async verify(commands) {
    if (!Array.isArray(commands) || commands.length === 0) {
      return [{
        ok: false,
        displayCommand: '(none)',
        stderr: 'Verification is required before an execution can be marked verified.',
        exitCode: null,
      }];
    }
    const results = [];
    for (const command of commands) {
      try {
        results.push(await this.terminal.run(command));
      } catch (error) {
        results.push({
          ok: false,
          displayCommand: commandSummary(command?.command ?? '(invalid)', command?.args ?? []),
          stderr: errorMessage(error),
          exitCode: null,
          timedOut: false,
          outputTruncated: false,
        });
      }
    }
    await this.evidence.writeJson('verification.json', results);
    return results;
  }

  async executeTransaction(plan) {
    if (!plan || !Array.isArray(plan.operations)) {
      throw new ExecutionError('A plan with an operations array is required.', 'INVALID_PLAN');
    }

    const maxAttempts = Math.min(Math.max(Number(plan.maxAttempts ?? 1), 1), 5);
    let activePlan = plan;
    const attempts = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const backups = new Map();
      const changes = [];
      let verification = [];
      let failure;

      try {
        for (const operation of activePlan.operations) {
          const backup = await this.#backupOperation(operation, backups);
          const change = await this.#applyOperation(operation);
          changes.push({ ...change, before: backup });
        }

        verification = await this.verify(activePlan.verification);
        if (verification.every((item) => item.ok)) {
          const diff = await this.#captureDiff();
          const result = {
            state: 'verified',
            attempts: attempt,
            changes: changes.map(({ before, ...change }) => change),
            verification,
            evidenceDirectory: this.evidence.directory,
            diff,
          };
          attempts.push(result);
          await this.evidence.writeJson('result.json', { state: result.state, attempts });
          await this.evidence.record('transaction_verified', { attempt, changes: result.changes.length });
          return result;
        }

        failure = analyseFailure(verification);
      } catch (error) {
        failure = {
          kind: error?.code === 'PERMISSION_DENIED' ? 'permission_denied' : 'operation_failed',
          summary: errorMessage(error),
          code: error?.code,
        };
      }

      const rollback = await this.#restore(backups);
      const failedAttempt = {
        state: 'failed_rolled_back',
        attempt,
        changes: changes.map(({ before, ...change }) => change),
        verification,
        failure,
        rollback,
      };
      attempts.push(failedAttempt);
      await this.evidence.record('transaction_failed_rolled_back', failedAttempt);

      if (attempt === maxAttempts || typeof activePlan.replan !== 'function') {
        const result = {
          state: 'failed_rolled_back',
          attempts: attempt,
          verification,
          failure,
          rollback,
          evidenceDirectory: this.evidence.directory,
          history: attempts,
        };
        await this.evidence.writeJson('result.json', result);
        return result;
      }

      const next = await activePlan.replan({ attempt, maxAttempts, failure, verification, changes });
      if (!next || !Array.isArray(next.operations)) {
        const result = {
          state: 'failed_rolled_back',
          attempts: attempt,
          verification,
          failure: { ...failure, replan: 'No valid replacement plan returned.' },
          rollback,
          evidenceDirectory: this.evidence.directory,
          history: attempts,
        };
        await this.evidence.writeJson('result.json', result);
        return result;
      }
      activePlan = { ...next, maxAttempts: maxAttempts - attempt, replan: activePlan.replan };
      await this.evidence.record('replan_applied', { nextAttempt: attempt + 1, failure });
    }

    throw new ExecutionError('Execution reached an unreachable state.', 'INTERNAL_ERROR');
  }

  async #backupOperation(operation, backups) {
    const relativePath = normalizeRelativePath(operation?.path);
    if (backups.has(relativePath)) return backups.get(relativePath);
    try {
      const current = await this.files.read(relativePath);
      const backup = { path: relativePath, exists: true, content: current.content, sha256: current.sha256 };
      backups.set(relativePath, backup);
      return backup;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        // RealWorkspace maps native ENOENT through unchanged; only absence is safe to treat as new.
        if (error?.code === 'NOT_FOUND' || /ENOENT/.test(errorMessage(error))) {
          const backup = { path: relativePath, exists: false };
          backups.set(relativePath, backup);
          return backup;
        }
        throw error;
      }
      const backup = { path: relativePath, exists: false };
      backups.set(relativePath, backup);
      return backup;
    }
  }

  async #applyOperation(operation) {
    if (!operation || typeof operation.type !== 'string') {
      throw new ExecutionError('Each operation needs a type.', 'INVALID_OPERATION');
    }
    switch (operation.type) {
      case 'write':
        return { type: 'write', ...(await this.files.write(operation.path, operation.content)) };
      case 'patch':
        return {
          type: 'patch',
          ...(await this.files.patch(operation.path, operation.expected, operation.replacement)),
        };
      case 'delete':
        return { type: 'delete', ...(await this.files.delete(operation.path)) };
      default:
        throw new ExecutionError(`Unsupported operation type: ${operation.type}`, 'INVALID_OPERATION');
    }
  }

  async #restore(backups) {
    const results = [];
    for (const backup of [...backups.values()].reverse()) {
      try {
        if (backup.exists) {
          await this.files.write(backup.path, backup.content);
          results.push({ path: backup.path, restored: true, mode: 'write' });
        } else {
          await this.files.delete(backup.path);
          results.push({ path: backup.path, restored: true, mode: 'delete' });
        }
      } catch (error) {
        results.push({ path: backup.path, restored: false, error: errorMessage(error) });
      }
    }
    return { ok: results.every((item) => item.restored), files: results };
  }

  async #captureDiff() {
    try {
      const diff = await this.git.diff();
      const payload = { available: diff.ok, stdout: diff.stdout, stderr: diff.stderr, exitCode: diff.exitCode };
      await this.evidence.writeText('git.diff', `${diff.stdout}${diff.stderr ? `\n${diff.stderr}` : ''}`);
      return payload;
    } catch (error) {
      const payload = { available: false, reason: errorMessage(error) };
      await this.evidence.writeJson('diff-unavailable.json', payload);
      return payload;
    }
  }
}

/** Convenience constructor used by the CLI and server-side adapters. */
export async function createExecutionEngine(options) {
  const engine = new AgentExecutionEngine(options);
  return engine.initialize();
}

export function defaultEvidenceDirectory(workspacePath) {
  return path.join(workspacePath, '.semo0o-evidence', `${Date.now()}-${os.hostname()}`);
}
