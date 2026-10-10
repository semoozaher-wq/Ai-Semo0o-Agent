import assert from 'node:assert/strict';
import test from 'node:test';
import { createLLMRouter } from '../llm/providers.mjs';

// -----------------------------------------------------------------------------
// Multimodal provider normalisation.
//
// The chat pipeline hands the router an OpenAI-style content array when a turn
// carries an image:
//   [{ type:'text', text }, { type:'image_url', image_url:{ url:'data:image/png;base64,...' } }]
// OpenAI accepts that verbatim, but Gemini needs `inlineData` parts and Anthropic
// needs base64 `image` blocks. Previously both providers JSON-stringified the
// array (the model saw a useless string, not the picture). These tests pin the
// translated wire shape for complete() and stream().
// -----------------------------------------------------------------------------

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DATA_B64 = DATA_URL.split(',')[1];

const MULTIMODAL_MESSAGES = [
  { role: 'system', content: 'be helpful' },
  { role: 'user', content: [{ type: 'text', text: 'describe this' }, { type: 'image_url', image_url: { url: DATA_URL } }] },
];

function withFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const record = { url: String(url), method: init?.method, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null };
    calls.push(record);
    return handler(record);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function ok(payload) {
  return { ok: true, status: 200, async text() { return JSON.stringify(payload); } };
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } });
  return { ok: true, status: 200, body, async text() { return chunks.join(''); } };
}

test('OpenAI receives the multimodal content array verbatim', async () => {
  const fetchMock = withFetch(() => ok({ choices: [{ message: { content: 'ok' } }], usage: {} }));
  try {
    const router = createLLMRouter({ OPENAI_API_KEY: 'sk-test', OPENAI_MODEL: 'gpt-5-mini' });
    await router.complete({ model: 'gpt-5-mini', messages: MULTIMODAL_MESSAGES });
    const sent = fetchMock.calls.at(-1).body;
    assert.deepEqual(sent.messages[1].content, MULTIMODAL_MESSAGES[1].content);
  } finally { fetchMock.restore(); }
});

test('Gemini translates the array into text + inlineData parts', async () => {
  const fetchMock = withFetch(() => ok({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: {} }));
  try {
    const router = createLLMRouter({ GEMINI_API_KEY: 'g-test', GEMINI_MODEL: 'gemini-3.5-flash-lite' });
    await router.complete({ model: 'gemini-3.5-flash-lite', messages: MULTIMODAL_MESSAGES });
    const sent = fetchMock.calls.at(-1).body;
    const parts = sent.contents[0].parts;
    assert.deepEqual(parts[0], { text: 'describe this' });
    assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/png', data: DATA_B64 } });
    assert.equal(sent.system_instruction.parts[0].text, 'be helpful');
  } finally { fetchMock.restore(); }
});

test('Anthropic translates the array into text + base64 image blocks', async () => {
  const fetchMock = withFetch(() => ok({ content: [{ type: 'text', text: 'ok' }], usage: {} }));
  try {
    const router = createLLMRouter({ ANTHROPIC_API_KEY: 'a-test', ANTHROPIC_MODEL: 'claude-haiku-4-5' });
    await router.complete({ model: 'claude-haiku-4-5', messages: MULTIMODAL_MESSAGES });
    const sent = fetchMock.calls.at(-1).body;
    const blocks = sent.messages[0].content;
    assert.deepEqual(blocks[0], { type: 'text', text: 'describe this' });
    assert.deepEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA_B64 } });
  } finally { fetchMock.restore(); }
});

test('Gemini streaming keeps the image part', async () => {
  const fetchMock = withFetch(() => sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n']));
  try {
    const router = createLLMRouter({ GEMINI_API_KEY: 'g-test', GEMINI_MODEL: 'gemini-3.5-flash-lite' });
    for await (const _frame of router.stream({ model: 'gemini-3.5-flash-lite', messages: MULTIMODAL_MESSAGES })) { /* drain */ }
    const sent = fetchMock.calls.at(-1).body;
    const parts = sent.contents[0].parts;
    assert.deepEqual(parts[1], { inlineData: { mimeType: 'image/png', data: DATA_B64 } });
  } finally { fetchMock.restore(); }
});

test('Anthropic streaming keeps the image block', async () => {
  const fetchMock = withFetch(() => sseResponse(['event: content_block_delta\ndata: {"delta":{"text":"ok"}}\n\n']));
  try {
    const router = createLLMRouter({ ANTHROPIC_API_KEY: 'a-test', ANTHROPIC_MODEL: 'claude-haiku-4-5' });
    for await (const _frame of router.stream({ model: 'claude-haiku-4-5', messages: MULTIMODAL_MESSAGES })) { /* drain */ }
    const sent = fetchMock.calls.at(-1).body;
    const blocks = sent.messages[0].content;
    assert.deepEqual(blocks[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA_B64 } });
  } finally { fetchMock.restore(); }
});
