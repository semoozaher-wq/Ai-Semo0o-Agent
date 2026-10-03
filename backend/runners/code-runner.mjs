import { createDockerCodeRunAdapter } from '../../execution-core/code-run-tool.mjs';
import { id, now, hash } from '../db/client.mjs';

export function createCodeRunHandler(db, { runner, getWorkspaceFiles } = {}) {
  const adapter = createDockerCodeRunAdapter({ runner, getWorkspaceFiles });
  return async ({ run, payload }) => {
    const result = await adapter({
      language: payload.language,
      source: payload.source,
      timeoutMs: payload.timeoutMs,
      maxOutputBytes: payload.maxOutputBytes,
    });
    const evidencePayload = JSON.stringify(result);
    db.run('INSERT INTO evidence(id,run_id,kind,payload_json,sha256,created_at) VALUES(?,?,?,?,?,?)', id('evidence'), run.id, 'code.run', evidencePayload, hash(evidencePayload), now());
    if (!result.ok) return { status: 'failed', ...result };
    return { status: 'completed', ...result };
  };
}
