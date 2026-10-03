import { DockerSandboxRunner } from './sandbox.mjs';

/**
 * Build the server-side adapter consumed by configureCodeRunAdapter().
 * Workspace files are copied into the isolated container as read-only input
 * from the caller's perspective; the runner itself owns the temporary mount.
 */
export function createDockerCodeRunAdapter({
  runner = new DockerSandboxRunner(),
  getWorkspaceFiles = async () => [],
} = {}) {
  return async (request) => {
    const files = await getWorkspaceFiles();
    const evidence = await runner.run({
      language: request.language,
      source: request.source,
      files,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxOutputBytes,
    });
    return {
      ...evidence,
      files: files.map((file) => file.path),
      isolated: true,
      network: 'none',
    };
  };
}

/**
 * Convenience bootstrap for a Node/Backend process. The app must explicitly
 * import the TypeScript registry and pass configureCodeRunAdapter() this
 * adapter; the client never calls this function.
 */
export async function runCodeInDocker(request, options = {}) {
  return createDockerCodeRunAdapter(options)(request);
}
