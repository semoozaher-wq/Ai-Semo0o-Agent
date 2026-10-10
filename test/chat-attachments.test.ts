import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planAttachmentUploads,
  stripAttachmentBytes,
  type AttachmentUploadClient,
} from '../src/services/chat/attachments';
import type { Attachment } from '../src/types/chat';

// -----------------------------------------------------------------------------
// Attachment upload planning — the "model never saw the file" incident.
//
// The composer reads a device file's real bytes into `dataBase64`. Before a
// chat/agent turn is sent, those bytes must be uploaded so the backend can hand
// the actual content to the model; attachments with no bytes (workspace files,
// URLs, oversized files) must still be referenced by name. These tests pin that
// planning contract, including the fail-soft behaviour on upload errors.
// -----------------------------------------------------------------------------

function attachment(overrides: Partial<Attachment> & Pick<Attachment, 'id' | 'name'>): Attachment {
  return {
    mimeType: 'text/plain',
    sizeBytes: 3,
    kind: 'document',
    ...overrides,
  } as Attachment;
}

function client(overrides: Partial<AttachmentUploadClient> = {}): AttachmentUploadClient {
  return {
    uploadAttachment: async () => ({ id: 'att_default' }),
    ...overrides,
  };
}

test('device files with real bytes are uploaded and returned as attachmentIds', async () => {
  const uploaded: string[] = [];
  const plan = await planAttachmentUploads(
    client({
      uploadAttachment: async (input) => {
        uploaded.push(`${input.name}:${input.dataBase64}`);
        return { id: `att_${input.name}` };
      },
    }),
    [
      attachment({ id: 'a1', name: 'notes.txt', dataBase64: 'aGVsbG8=' }),
      attachment({ id: 'a2', name: 'photo.png', mimeType: 'image/png', kind: 'image', dataBase64: 'iVBORw0KGgo=' }),
    ],
  );
  assert.deepEqual(plan.attachmentIds, ['att_notes.txt', 'att_photo.png']);
  assert.deepEqual(plan.referenceOnly, []);
  assert.deepEqual(uploaded, ['notes.txt:aGVsbG8=', 'photo.png:iVBORw0KGgo=']);
});

test('attachments without bytes are kept as name-only references, not uploaded', async () => {
  let uploadCalls = 0;
  const plan = await planAttachmentUploads(
    client({
      uploadAttachment: async () => {
        uploadCalls += 1;
        return { id: 'att_x' };
      },
    }),
    [
      attachment({ id: 'w1', name: 'src/index.ts', uri: 'workspace://src/index.ts', kind: 'code' }),
      attachment({ id: 'u1', name: 'https://example.com', mimeType: 'text/uri-list', kind: 'other' }),
    ],
  );
  assert.deepEqual(plan.attachmentIds, []);
  assert.deepEqual(plan.referenceOnly.map((item) => item.name), ['src/index.ts', 'https://example.com']);
  assert.equal(uploadCalls, 0, 'no bytes means nothing to upload');
});

test('an upload failure degrades that attachment to a reference (never dropped)', async () => {
  const plan = await planAttachmentUploads(
    client({
      uploadAttachment: async (input) => {
        if (input.name === 'bad.bin') throw new Error('ATTACHMENT_TOO_LARGE');
        return { id: `att_${input.name}` };
      },
    }),
    [
      attachment({ id: 'a1', name: 'good.txt', dataBase64: 'b2s=' }),
      attachment({ id: 'a2', name: 'bad.bin', dataBase64: 'AAEC' }),
    ],
  );
  assert.deepEqual(plan.attachmentIds, ['att_good.txt']);
  assert.deepEqual(plan.referenceOnly.map((item) => item.name), ['bad.bin']);
});

test('an already-uploaded attachment reuses its backendId without re-uploading', async () => {
  let uploadCalls = 0;
  const plan = await planAttachmentUploads(
    client({
      uploadAttachment: async () => {
        uploadCalls += 1;
        return { id: 'att_new' };
      },
    }),
    [attachment({ id: 'a1', name: 'cached.txt', dataBase64: 'aGVsbG8=', backendId: 'att_cached' })],
  );
  assert.deepEqual(plan.attachmentIds, ['att_cached']);
  assert.equal(uploadCalls, 0);
});

test('the conversationId is forwarded so the upload is linked to the thread', async () => {
  let seen: string | undefined;
  await planAttachmentUploads(
    client({
      uploadAttachment: async (input) => {
        seen = input.conversationId;
        return { id: 'att_1' };
      },
    }),
    [attachment({ id: 'a1', name: 'notes.txt', dataBase64: 'aGVsbG8=' })],
    'conv_backend_1',
  );
  assert.equal(seen, 'conv_backend_1');
});

test('stripAttachmentBytes removes base64 before persistence but keeps metadata', () => {
  const stripped = stripAttachmentBytes([
    attachment({ id: 'a1', name: 'notes.txt', dataBase64: 'aGVsbG8=', backendId: 'att_1' }),
  ]);
  assert.equal(stripped.length, 1);
  assert.equal(stripped[0]?.name, 'notes.txt');
  assert.equal(stripped[0]?.backendId, 'att_1');
  assert.equal('dataBase64' in (stripped[0] as object), false, 'base64 must not be persisted');
});
