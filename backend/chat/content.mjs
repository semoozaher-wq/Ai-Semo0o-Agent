/**
 * backend/chat/content.mjs — Build the model message from a user turn + files.
 *
 * Turns a text prompt plus a set of loaded attachments into a single content
 * value the LLM router understands:
 *   - text-like files (source code, JSON, CSV, markdown, plain text, …) are
 *     decoded and inlined under a labelled block, truncated to a bounded size;
 *   - images are emitted as OpenAI-style `image_url` data-URL parts so a
 *     vision-capable model actually sees the picture;
 *   - binary files that cannot be inlined (PDF/audio/archives) are disclosed by
 *     name + type + size so the model is never told it received content it did
 *     not.
 *
 * The result is either a plain string (no images) or an array of OpenAI content
 * parts. `providers.mjs` normalises the array into each provider's native
 * multimodal shape, so the same builder works for OpenAI, Gemini and Anthropic.
 */

// Per-file inline budget and total budget across all files in one turn.
const MAX_INLINE_CHARS_PER_FILE = 24_000;
const MAX_INLINE_CHARS_TOTAL = 60_000;

const TEXT_MIME_PREFIXES = ['text/'];
const TEXT_MIME_EXACT = new Set([
  'application/json', 'application/ld+json', 'application/xml', 'application/x-yaml',
  'application/yaml', 'application/javascript', 'application/typescript', 'application/x-sh',
  'application/sql', 'application/csv', 'application/x-ndjson',
]);
const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'markdown', 'css', 'scss', 'html', 'htm',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sql',
  'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'env', 'txt', 'csv', 'tsv', 'log', 'xml', 'svg',
]);

function extensionOf(name) {
  const value = String(name ?? '');
  return value.includes('.') ? value.split('.').pop().toLowerCase() : '';
}

/** True when the attachment's bytes are safe to decode and inline as text. */
export function isTextLike(name, mimeType) {
  const mime = String(mimeType ?? '').toLowerCase();
  if (TEXT_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) return true;
  if (TEXT_MIME_EXACT.has(mime)) return true;
  // A missing/opaque mime type still inlines when the extension is known-text.
  if (!mime || mime === 'application/octet-stream') return TEXT_EXT.has(extensionOf(name));
  return false;
}

function decodeUtf8(buffer) {
  // Strip a UTF-8 BOM and any NUL bytes so binary-ish content cannot corrupt the
  // prompt; replacement chars are acceptable for a best-effort text read.
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  return text.includes('\u0000') ? text.replace(/\u0000/g, '') : text;
}

/**
 * Build the model content for one user turn.
 *
 * @returns {{ content: string | Array<object>, images: number, inlined: number, skipped: number, summary: string[] }}
 */
export function buildChatContent({ text = '', attachments = [] } = {}) {
  const parts = [];
  const summary = [];
  let images = 0;
  let inlined = 0;
  let skipped = 0;
  let inlineBudget = MAX_INLINE_CHARS_TOTAL;
  let body = typeof text === 'string' ? text : '';

  for (const item of attachments) {
    const record = item?.record ?? {};
    const buffer = item?.buffer ?? Buffer.alloc(0);
    const label = record.name || 'attachment';
    const kind = record.kind || 'other';

    if (kind === 'image' || String(record.mimeType ?? '').startsWith('image/')) {
      const mime = record.mimeType || 'image/png';
      // SVG is text; inline it as text so a non-vision model can still read it.
      if (mime === 'image/svg+xml') {
        const snippet = decodeUtf8(buffer).slice(0, Math.min(MAX_INLINE_CHARS_PER_FILE, inlineBudget));
        inlineBudget -= snippet.length;
        body += `\n\n[${label}]\n${snippet}`;
        inlined += 1;
        summary.push(`${label}: svg inlined`);
        continue;
      }
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } });
      images += 1;
      summary.push(`${label}: image (${mime}, ${buffer.length} bytes)`);
      continue;
    }

    if (isTextLike(record.name, record.mimeType)) {
      const limit = Math.max(0, Math.min(MAX_INLINE_CHARS_PER_FILE, inlineBudget));
      const decoded = decodeUtf8(buffer);
      const snippet = decoded.slice(0, limit);
      inlineBudget -= snippet.length;
      body += `\n\n[${label}]\n${snippet}${decoded.length > snippet.length ? '\n…(truncated)' : ''}`;
      inlined += 1;
      summary.push(`${label}: text inlined (${snippet.length}/${decoded.length} chars)`);
      continue;
    }

    // Binary content we cannot inline: disclose it honestly instead of silently
    // dropping it, so the model can ask the user to paste the relevant part.
    skipped += 1;
    const note = `[${label} — ${record.mimeType || 'application/octet-stream'}, ${buffer.length} bytes؛ محتوى ثنائي غير مُضمّن]`;
    body += `\n\n${note}`;
    summary.push(`${label}: binary (${record.mimeType || 'unknown'}, ${buffer.length} bytes) not inlined`);
  }

  if (!images) return { content: body, images, inlined, skipped, summary };
  parts.unshift({ type: 'text', text: body });
  return { content: parts, images, inlined, skipped, summary };
}

/**
 * A short, model-facing description of the attachments for the AGENT run goal
 * (the agent planner works from text, so images are described and text files are
 * inlined the same way). Returns the enriched goal string.
 */
export function buildAgentGoal({ goal = '', attachments = [] } = {}) {
  const { content, summary } = buildChatContent({ text: goal, attachments });
  const list = summary.length ? `\n\n[المرفقات]\n${summary.map((line) => `- ${line}`).join('\n')}` : '';
  if (typeof content === 'string') return `${content}${list}`;
  // Agent goals are text; when images are present, keep the text block and note
  // the image count (the run payload carries the raw attachment ids separately).
  const textPart = content.find((part) => part.type === 'text');
  return `${textPart?.text ?? goal}${list}`;
}
