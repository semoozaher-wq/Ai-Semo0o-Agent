import type { Attachment } from '../../types/chat';

/**
 * Attachment upload planning for the chat store.
 *
 * The chat API historically received only attachment *metadata* (name/size/
 * mime), so the model never saw a file's actual content. The composer now reads
 * a device file's real bytes into `dataBase64`; this module turns the queued
 * attachments into a request plan:
 *
 *   - device files that carry real bytes are uploaded once (the server returns
 *     an id) and sent as `attachmentIds`, so the backend can load their content
 *     back and hand it to the model (text inlined, images as vision parts);
 *   - attachments with no bytes (workspace files, URLs, oversized files) and any
 *     upload that fails are returned as `referenceOnly`, to be folded into the
 *     prompt text as honest name/type references — never silently dropped.
 *
 * The logic is dependency-free (the client is injected) so it can be unit-tested
 * without pulling in react-native or the network.
 */

/** Minimal client surface the uploader needs (satisfied by `backendApi`). */
export interface AttachmentUploadClient {
  uploadAttachment(input: {
    name: string;
    mimeType: string;
    dataBase64: string;
    conversationId?: string;
  }): Promise<{ id: string }>;
}

export interface UploadPlan {
  /** Server ids to send with the chat/run request. */
  attachmentIds: string[];
  /** Attachments that could only be referenced by name in the prompt text. */
  referenceOnly: Attachment[];
}

/**
 * Decide what to upload for one user turn. Never throws: an upload failure
 * degrades to a text reference so the turn still carries honest context.
 */
export async function planAttachmentUploads(
  client: AttachmentUploadClient,
  attachments: Attachment[],
  conversationId?: string,
): Promise<UploadPlan> {
  const attachmentIds: string[] = [];
  const referenceOnly: Attachment[] = [];
  for (const item of attachments) {
    // Already uploaded (e.g. a retry): reuse the server id, do not re-upload.
    if (item.backendId) {
      attachmentIds.push(item.backendId);
      continue;
    }
    if (!item.dataBase64) {
      referenceOnly.push(item);
      continue;
    }
    try {
      const stored = await client.uploadAttachment({
        name: item.name,
        mimeType: item.mimeType,
        dataBase64: item.dataBase64,
        ...(conversationId ? { conversationId } : {}),
      });
      // Remember the id on the attachment so a later send reuses it.
      item.backendId = stored.id;
      attachmentIds.push(stored.id);
    } catch {
      referenceOnly.push(item);
    }
  }
  return { attachmentIds, referenceOnly };
}

/**
 * Strip the base64 bytes from attachments before they are persisted to local
 * storage. The bytes can be multi-megabyte; keeping them would bloat storage
 * (and they are not needed to render the message).
 */
export function stripAttachmentBytes(attachments: Attachment[]): Attachment[] {
  return attachments.map((item) => {
    const copy = { ...item };
    delete copy.dataBase64;
    return copy;
  });
}
