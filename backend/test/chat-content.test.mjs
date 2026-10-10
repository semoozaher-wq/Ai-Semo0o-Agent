import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatContent, buildAgentGoal, isTextLike } from '../chat/content.mjs';

/**
 * The chat/agent pipelines must feed the model the ACTUAL file content, not just
 * a filename. These tests pin the builder contract:
 *   - text-like files are inlined (bounded) under a labelled block;
 *   - images become OpenAI-style `image_url` data-URL parts (vision models see
 *     the pixels);
 *   - SVG is inlined as text (so a non-vision model can still read it);
 *   - binary files we cannot inline are disclosed honestly (never silently
 *     dropped, never faked as "content received").
 */

function attachment(name, mimeType, kind, body) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return { record: { name, mimeType, kind, sizeBytes: buffer.length }, buffer };
}

test('isTextLike classifies by mime prefix, exact mime, and extension fallback', () => {
  assert.equal(isTextLike('a.txt', 'text/plain'), true);
  assert.equal(isTextLike('data.json', 'application/json'), true);
  assert.equal(isTextLike('main.ts', ''), true);
  assert.equal(isTextLike('main.ts', 'application/octet-stream'), true);
  assert.equal(isTextLike('photo.png', 'image/png'), false);
  assert.equal(isTextLike('report.pdf', 'application/pdf'), false);
});

test('a text file is inlined under a labelled block (no images => plain string)', () => {
  const built = buildChatContent({ text: 'summarise this', attachments: [attachment('notes.txt', 'text/plain', 'document', 'line one\nline two')] });
  assert.equal(typeof built.content, 'string');
  assert.match(built.content, /summarise this/);
  assert.match(built.content, /\[notes\.txt\]/);
  assert.match(built.content, /line one\nline two/);
  assert.equal(built.inlined, 1);
  assert.equal(built.images, 0);
  assert.equal(built.skipped, 0);
});

test('an image becomes an image_url data-URL part and yields an array content', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const built = buildChatContent({ text: 'what is this', attachments: [attachment('pic.png', 'image/png', 'image', png)] });
  assert.ok(Array.isArray(built.content));
  const imagePart = built.content.find((part) => part.type === 'image_url');
  assert.ok(imagePart, 'an image_url part must be present');
  assert.equal(imagePart.image_url.url, `data:image/png;base64,${png.toString('base64')}`);
  const textPart = built.content.find((part) => part.type === 'text');
  assert.match(textPart.text, /what is this/);
  assert.equal(built.images, 1);
});

test('an SVG is inlined as text instead of sent as an image part', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  const built = buildChatContent({ attachments: [attachment('logo.svg', 'image/svg+xml', 'image', svg)] });
  assert.equal(typeof built.content, 'string');
  assert.match(built.content, /<svg/);
  assert.equal(built.images, 0);
  assert.equal(built.inlined, 1);
});

test('an un-inlinable binary file is disclosed, not silently dropped', () => {
  const built = buildChatContent({ text: 'see attached', attachments: [attachment('report.pdf', 'application/pdf', 'document', Buffer.from([0x25, 0x50, 0x44, 0x46]))] });
  assert.equal(typeof built.content, 'string');
  assert.match(built.content, /report\.pdf/);
  assert.match(built.content, /application\/pdf/);
  assert.equal(built.skipped, 1);
  assert.equal(built.inlined, 0);
});

test('a large text file is truncated with a marker rather than blowing the prompt', () => {
  const huge = 'x'.repeat(30_000);
  const built = buildChatContent({ attachments: [attachment('big.log', 'text/plain', 'document', huge)] });
  assert.match(built.content, /truncated/);
  assert.ok(built.content.length < huge.length, 'the inline must be bounded');
});

test('buildAgentGoal inlines the real text content and appends an attachment list', () => {
  const goal = buildAgentGoal({ goal: 'refactor the module', attachments: [attachment('src.ts', 'text/plain', 'code', 'export const x = 1;')] });
  assert.match(goal, /refactor the module/);
  assert.match(goal, /export const x = 1;/);
  assert.match(goal, /\[المرفقات\]/);
  assert.match(goal, /src\.ts/);
});

test('buildAgentGoal keeps the text goal when an image is attached (goal stays a string)', () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const goal = buildAgentGoal({ goal: 'describe the screenshot', attachments: [attachment('shot.png', 'image/png', 'image', png)] });
  assert.equal(typeof goal, 'string');
  assert.match(goal, /describe the screenshot/);
  assert.match(goal, /shot\.png/);
});
