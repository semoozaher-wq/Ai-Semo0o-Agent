/**
 * backend/chat/attachments.mjs — Tenant-scoped attachment storage.
 *
 * The chat API historically accepted only text; a user "attaching" a file sent
 * nothing but its name/size/mime, so the model never saw the actual content.
 * This module closes that gap: the client uploads the real bytes (base64), the
 * server validates and persists them under a TENANT-SCOPED directory, and the
 * chat pipeline loads them back to build the model message.
 *
 * Isolation guarantees:
 *   - every read/write is keyed by (tenant_id, user_id); a record from another
 *     tenant is indistinguishable from a missing one (NOT_FOUND, never FORBIDDEN
 *     which would leak existence);
 *   - the on-disk path is derived from the generated id, never from the
 *     user-supplied name, so a crafted name can never traverse the filesystem;
 *   - the bytes are re-hashed on load and compared to the stored digest.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;

// 8 MiB of decoded content. base64 inflates by ~4/3, so the HTTP body limit the
// server applies to the upload route must be a little larger than this.
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const KINDS = Object.freeze(['image', 'document', 'audio', 'code', 'other']);

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
const AUDIO_EXT = ['mp3', 'wav', 'ogg', 'm4a', 'aac'];
const CODE_EXT = ['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'css', 'html', 'md', 'sh', 'yml', 'yaml'];
const DOC_EXT = ['pdf', 'doc', 'docx', 'txt', 'rtf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'];

function extensionOf(name) {
  const value = String(name ?? '');
  return value.includes('.') ? value.split('.').pop().toLowerCase() : '';
}

/** Best-effort attachment classification from name + mime type (mirrors the client). */
export function attachmentKind(name, mimeType = '') {
  const mime = String(mimeType ?? '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = extensionOf(name);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (CODE_EXT.includes(ext)) return 'code';
  if (DOC_EXT.includes(ext)) return 'document';
  return 'other';
}

function boundedName(value) {
  const name = typeof value === 'string' && value.trim() ? value.trim() : 'attachment';
  return name.slice(0, 200);
}

function boundedMime(value) {
  const mime = typeof value === 'string' && value.trim() ? value.trim() : 'application/octet-stream';
  return mime.slice(0, 120);
}

// A base64 payload may arrive with or without a data-URL prefix; both are
// accepted. Anything that is not valid base64 is rejected before decoding.
function decodeBase64(dataBase64) {
  if (typeof dataBase64 !== 'string' || dataBase64.length === 0) throw new Error('ATTACHMENT_DATA_REQUIRED');
  const comma = dataBase64.indexOf(',');
  const raw = dataBase64.startsWith('data:') && comma !== -1 ? dataBase64.slice(comma + 1) : dataBase64;
  if (!/^[A-Za-z0-9+/=\r\n]*$/.test(raw)) throw new Error('ATTACHMENT_DATA_INVALID');
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new Error('ATTACHMENT_DATA_INVALID');
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('ATTACHMENT_TOO_LARGE');
  return buffer;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Resolve the directory that holds attachment payloads. Mirrors the workspace
 * root resolution: prefer an operator-configured ATTACHMENTS_ROOT, fall back to
 * a project-relative directory, and finally to the OS temp dir so the process
 * can always boot. The directory is created 0700 (private) on first use.
 */
export function resolveAttachmentRoot(env = process.env) {
  const candidates = [];
  if (env.ATTACHMENTS_ROOT) candidates.push(path.resolve(env.ATTACHMENTS_ROOT));
  candidates.push(path.resolve('backend', 'data', 'attachments'));
  candidates.push(path.join(os.tmpdir(), 'semo0o', 'attachments'));
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('ATTACHMENT_ROOT_UNWRITABLE');
}

function deserialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    conversationId: row.conversation_id ?? null,
    name: row.name,
    mimeType: row.mime_type,
    kind: row.kind,
    sizeBytes: Number(row.size_bytes) || 0,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export class AttachmentStore {
  constructor(db, { root } = {}) {
    this.db = db;
    this.root = root ?? resolveAttachmentRoot();
  }

  /** Absolute on-disk path for a record. Never derived from the user's name. */
  filePathFor(tenantId, attachmentId) {
    return path.join(this.root, String(tenantId), `${attachmentId}.bin`);
  }

  /**
   * Persist an uploaded attachment. Returns the metadata view (never the bytes).
   * `conversationId`, when supplied, must already belong to the same user.
   */
  save({ tenantId, userId, name, mimeType, dataBase64, conversationId = null }) {
    if (!tenantId || !userId) throw new Error('ATTACHMENT_OWNER_REQUIRED');
    if (conversationId) {
      const owned = this.db.get('SELECT id FROM conversations WHERE id=? AND tenant_id=? AND user_id=?', conversationId, tenantId, userId);
      if (!owned) throw new Error('CONVERSATION_NOT_FOUND');
    }
    const buffer = decodeBase64(dataBase64);
    const attachmentId = id('att');
    const kind = attachmentKind(name, mimeType);
    const directory = path.join(this.root, String(tenantId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filePath = this.filePathFor(tenantId, attachmentId);
    writeFileSync(filePath, buffer, { mode: 0o600 });
    const digest = sha256(buffer);
    const timestamp = now();
    try {
      this.db.run(
        'INSERT INTO attachments(id,tenant_id,user_id,conversation_id,name,mime_type,kind,size_bytes,storage_path,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        attachmentId, tenantId, userId, conversationId, boundedName(name), boundedMime(mimeType), kind, buffer.length, filePath, digest, timestamp,
      );
    } catch (error) {
      try { rmSync(filePath, { force: true }); } catch { /* best-effort cleanup */ }
      throw error;
    }
    return deserialize(this.db.get('SELECT * FROM attachments WHERE id=? AND tenant_id=? AND user_id=?', attachmentId, tenantId, userId));
  }

  /** Metadata for one attachment, scoped to its owner. */
  getMeta({ tenantId, userId, attachmentId }) {
    return deserialize(this.db.get('SELECT * FROM attachments WHERE id=? AND tenant_id=? AND user_id=?', attachmentId, tenantId, userId));
  }

  /** Metadata + verified bytes. Throws NOT_FOUND when the owner does not match. */
  getContent({ tenantId, userId, attachmentId }) {
    const record = this.getMeta({ tenantId, userId, attachmentId });
    if (!record) throw new Error('ATTACHMENT_NOT_FOUND');
    const filePath = this.filePathFor(tenantId, record.id);
    if (!existsSync(filePath)) throw new Error('ATTACHMENT_FILE_MISSING');
    const buffer = readFileSync(filePath);
    if (sha256(buffer) !== record.sha256) throw new Error('ATTACHMENT_INTEGRITY_FAILED');
    return { record, buffer };
  }

  /**
   * Load several attachments for the chat pipeline. Every id must belong to the
   * caller; a foreign or unknown id fails closed (ATTACHMENT_NOT_FOUND) so the
   * caller cannot probe for other tenants' uploads.
   */
  loadMany({ tenantId, userId, attachmentIds = [] }) {
    const unique = [...new Set(attachmentIds.filter((value) => typeof value === 'string' && value))];
    return unique.map((attachmentId) => this.getContent({ tenantId, userId, attachmentId }));
  }

  /** Delete one attachment (owner-scoped) and its bytes. */
  remove({ tenantId, userId, attachmentId }) {
    const record = this.getMeta({ tenantId, userId, attachmentId });
    if (!record) throw new Error('ATTACHMENT_NOT_FOUND');
    this.db.run('DELETE FROM attachments WHERE id=? AND tenant_id=? AND user_id=?', attachmentId, tenantId, userId);
    try { rmSync(this.filePathFor(tenantId, attachmentId), { force: true }); } catch { /* best-effort */ }
    return { deleted: true, attachmentId };
  }
}

export function createAttachmentStore(db, options = {}) {
  return new AttachmentStore(db, options);
}
