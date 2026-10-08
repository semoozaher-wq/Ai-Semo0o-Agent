import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { id, now } from '../db/client.mjs';

// =============================================================================
// backend/artifacts/store.mjs
// -----------------------------------------------------------------------------
// Durable artifact ledger.
//
// The `artifacts` table already existed in schema.sql but nothing ever wrote to
// it: generated files (images, office documents, audio, video) were only
// referenced by a transient tool result and were lost the moment the run
// finished. This module turns that dead table into a real, queryable ledger of
// the files a run actually produced, with a content hash so an operator can
// verify that a stored artifact has not been tampered with or truncated.
//
// Design rules (shared with the rest of the backend):
//   - additive: it only ever INSERTs/SELECTs/DELETEs from `artifacts`;
//   - bounded: hashing reads the file once and never buffers more than the file
//     itself; callers can cap the size before recording;
//   - honest: `verify()` re-hashes the file on disk and reports the real result,
//     it never assumes success.
// =============================================================================

/** Hex SHA-256 of a Buffer/string. */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

const MIME_BY_EXT = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf', '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
});

/** Best-effort MIME type from a file extension; defaults to application/octet-stream. */
export function guessMimeType(filePath) {
  return MIME_BY_EXT[path.extname(String(filePath || '')).toLowerCase()] ?? 'application/octet-stream';
}

const MAX_RECORD_BYTES = 64 * 1024 * 1024; // 64 MB hard cap on a single recorded artifact

export class ArtifactStore {
  constructor(db) {
    if (!db) throw new Error('ARTIFACT_STORE_DB_REQUIRED');
    this.db = db;
  }

  /** Record an in-memory buffer as an artifact. Returns the stored row. */
  recordBuffer({ runId, path: artifactPath, buffer, kind = 'file', mimeType, meta = null } = {}) {
    if (!runId) throw new Error('ARTIFACT_RUN_REQUIRED');
    if (!artifactPath) throw new Error('ARTIFACT_PATH_REQUIRED');
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '');
    if (bytes.length > MAX_RECORD_BYTES) throw new Error('ARTIFACT_TOO_LARGE');
    return this.#insert({ runId, artifactPath, sha256: sha256Hex(bytes), sizeBytes: bytes.length, kind, mimeType, meta });
  }

  /** Record a file already on disk. Returns the stored row. */
  async recordFile({ runId, absolutePath, path: artifactPath, kind = 'file', mimeType, meta = null } = {}) {
    if (!runId) throw new Error('ARTIFACT_RUN_REQUIRED');
    if (!absolutePath) throw new Error('ARTIFACT_SOURCE_REQUIRED');
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error('ARTIFACT_SOURCE_NOT_FILE');
    if (info.size > MAX_RECORD_BYTES) throw new Error('ARTIFACT_TOO_LARGE');
    const bytes = await readFile(absolutePath);
    return this.#insert({ runId, artifactPath: artifactPath ?? absolutePath, sha256: sha256Hex(bytes), sizeBytes: bytes.length, kind, mimeType, meta });
  }

  #insert({ runId, artifactPath, sha256, sizeBytes, kind, mimeType, meta }) {
    const artifactId = id('artifact');
    const timestamp = now();
    this.db.run(
      'INSERT INTO artifacts(id,run_id,path,sha256,size_bytes,kind,mime_type,meta_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      artifactId, runId, artifactPath, sha256, sizeBytes, kind, mimeType ?? guessMimeType(artifactPath), meta ? JSON.stringify(meta) : null, timestamp, timestamp,
    );
    return this.get(artifactId);
  }

  get(artifactId) {
    return this.db.get('SELECT * FROM artifacts WHERE id=?', artifactId) ?? null;
  }

  list(runId) {
    return this.db.all('SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at ASC, id ASC', runId);
  }

  listByPath(runId, artifactPath) {
    return this.db.all('SELECT * FROM artifacts WHERE run_id=? AND path=? ORDER BY created_at DESC', runId, artifactPath);
  }

  count(runId) {
    return this.db.get('SELECT COUNT(*) AS n FROM artifacts WHERE run_id=?', runId)?.n ?? 0;
  }

  /** Re-hash the file on disk and compare it to the recorded digest. */
  async verify(artifactId, absolutePath) {
    const artifact = this.get(artifactId);
    if (!artifact) throw new Error('ARTIFACT_NOT_FOUND');
    const bytes = await readFile(absolutePath);
    const actual = sha256Hex(bytes);
    return { ok: actual === artifact.sha256, expected: artifact.sha256, actual, sizeBytes: bytes.length, path: artifact.path };
  }

  delete(artifactId) {
    const result = this.db.run('DELETE FROM artifacts WHERE id=?', artifactId);
    return { deleted: result.changes === 1 };
  }
}

export function createArtifactStore(db) {
  return new ArtifactStore(db);
}
