import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

// -----------------------------------------------------------------------------
// Image-attachment rendering — the "upload an image, see only a filename" gap.
//
// The chat bubble rendered every attachment as a name/icon pill, so a user who
// attached an image could not see it. The bubble now renders a real thumbnail
// (from inline bytes, or by fetching the stored bytes with the session token).
// For that fetch to work, the optimistic user turn must keep the server
// attachment id — which the uploader stamps on AFTER the message is built.
// These tests pin both halves of that wiring.
// -----------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

test('ChatBubble renders a real image thumbnail (not just a pill)', () => {
  const source = read('src/components/composite/ChatBubble.tsx');
  assert.match(source, /import \{ ActivityIndicator, Image, Pressable, StyleSheet, View \} from 'react-native'/, 'ChatBubble must import Image');
  assert.match(source, /function AttachmentPreview\(/, 'ChatBubble must define an image-aware preview');
  assert.match(source, /<Image\b/, 'the preview must render an <Image>');
  assert.match(source, /backendApi\.fetchAttachmentDataUrl\(attachment\.backendId\)/, 'the preview must fetch stored bytes for backend attachments');
  assert.match(source, /<AttachmentPreview key=\{attachment\.id\}/, 'attachments must render through the preview');
  // A failed image must degrade to the pill, never a broken image.
  assert.match(source, /onError=\{\(\) => setFailed\(true\)\}/, 'an image error must fall back to the pill');
});

test('fetchAttachmentDataUrl is Bearer-authenticated and fails soft', () => {
  const source = read('src/services/api/client.ts');
  assert.match(source, /async fetchAttachmentDataUrl\(id: string\): Promise<string \| null>/, 'the client must expose fetchAttachmentDataUrl');
  assert.match(source, /\/attachments\/\$\{encodeURIComponent\(id\)\}\/content/, 'it must hit the attachment content route');
  assert.match(source, /authorization: `Bearer \$\{this\.token\}`/, 'it must send the Bearer token');
  assert.match(source, /catch \{\s*return null;/, 'a failed fetch must return null, not throw');
});

test('the optimistic user turn keeps the server attachment id after upload', () => {
  const source = read('src/store/useChatStore.ts');
  // After the uploader stamps ids, the user message is patched so a retry reuses
  // the upload and the UI can fetch the stored bytes.
  assert.match(source, /if \(attachments\.some\(\(item\) => item\.backendId\)\)/, 'send() must detect stamped backend ids');
  assert.match(source, /patchMessage\(conversationId, userMessage\.id, \{ attachments: stripAttachmentBytes\(attachments\) \}\)/, 'send() must mirror the ids onto the user turn');
});
