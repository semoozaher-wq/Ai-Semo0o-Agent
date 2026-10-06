import { registerTool, unregisterTool, type ToolImplementation } from './tools';

export interface CodeRunFile {
  path: string;
  content: string;
}

export interface CodeRunRequest {
  language: 'javascript' | 'typescript' | 'python';
  source: string;
  files?: CodeRunFile[] | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
}

export interface CodeRunEvidence {
  ok: boolean;
  language: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string | null;
  durationMs: number;
  timedOut?: boolean;
  outputTruncated?: boolean;
  isolated: boolean;
  network: 'none';
  files: string[];
  evidenceDirectory?: string;
  [key: string]: unknown;
}

export type CodeRunAdapter = (request: CodeRunRequest) => Promise<CodeRunEvidence>;

let configuredAdapter: CodeRunAdapter | undefined;

/**
 * Configure the server-side runner. The Expo/browser client must not provide
 * this callback: it cannot safely execute processes. Without configuration,
 * code.run fails explicitly instead of fabricating a result.
 */
export function configureCodeRunAdapter(adapter: CodeRunAdapter): void {
  configuredAdapter = adapter;
}

export function clearCodeRunAdapter(): void {
  configuredAdapter = undefined;
}

export function isCodeRunConfigured(): boolean {
  return Boolean(configuredAdapter);
}

function normalizeRequest(args: Record<string, unknown>): CodeRunRequest {
  const language = args.language;
  if (language !== 'javascript' && language !== 'typescript' && language !== 'python') {
    throw new Error(`لغة code.run غير مدعومة: ${String(language)}`);
  }
  if (typeof args.source !== 'string' || args.source.length === 0) {
    throw new Error('الحقل «source» مطلوب لـ code.run');
  }
  return {
    language,
    source: args.source,
    timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
    maxOutputBytes: typeof args.maxOutputBytes === 'number' ? args.maxOutputBytes : undefined,
  };
}

const implementation: ToolImplementation = async (args) => {
  if (!configuredAdapter) {
    throw new Error('CODE_RUNNER_NOT_CONFIGURED: code.run requires an authenticated server runner; no fake execution is available.');
  }
  const request = normalizeRequest(args);
  const evidence = await configuredAdapter(request);
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('CODE_RUNNER_INVALID_EVIDENCE');
  }
  return {
    output: evidence,
    simulated: false,
    logs: [
      `code.run ${request.language}: exitCode=${String(evidence.exitCode)}, ok=${String(evidence.ok)}`,
      `evidence: ${evidence.evidenceDirectory ?? 'inline'}`,
    ],
  };
};

/** Register the bridge only in a runtime that has deliberately chosen it. */
export function registerCodeRunTool(): void {
  registerTool('code.run', implementation);
}

export function unregisterCodeRunTool(): void {
  unregisterTool('code.run');
}
