#!/usr/bin/env node
/**
 * mock-llm-server.mjs — a LOCAL, OpenAI-compatible mock used ONLY to prove the
 * generation pipeline end-to-end when no real provider keys are available.
 *
 * IMPORTANT / HONESTY NOTES
 * -------------------------
 * - This is NOT a real AI provider and it is NOT used in production. It returns
 *   a canned, deterministic reply so we can verify that the backend orchestration
 *   (auth -> chat route -> LLM router -> provider adapter -> response -> DB)
 *   works end to end.
 * - No real API key is fabricated: the backend is pointed here via
 *   OPENAI_API_BASE, and OPENAI_API_KEY is a clearly-labelled local placeholder
 *   ("local-mock-not-a-real-key"). Nothing leaves the sandbox.
 * - It implements just enough of the OpenAI Chat Completions contract
 *   (POST /v1/chat/completions) for the backend's openaiComplete() adapter.
 *
 * Usage: node scripts/mock-llm-server.mjs [port]
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || process.env.MOCK_LLM_PORT || 8790);

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'mock-llm' }));
    return;
  }

  if (req.method === 'POST' && /\/chat\/completions$/.test(req.url || '')) {
    const raw = await readBody(req);
    let payload = {};
    try { payload = JSON.parse(raw); } catch { /* ignore */ }

    const lastUser = Array.isArray(payload.messages)
      ? [...payload.messages].reverse().find((m) => m.role === 'user')
      : null;
    const userText =
      typeof lastUser?.content === 'string'
        ? lastUser.content
        : Array.isArray(lastUser?.content)
          ? lastUser.content.map((p) => p.text || '').join(' ')
          : '';

    const reply =
      `[MOCK-LLM] تم استلام رسالتك بنجاح عبر خط الأنابيب الكامل. ` +
      `عدد الرسائل=${payload.messages?.length ?? 0}، النموذج المطلوب=${payload.model ?? 'n/a'}. ` +
      `محتوى المستخدم: ${String(userText).slice(0, 200)}`;

    // Streaming path: emit OpenAI-style SSE chunks so the backend's openaiStream()
    // adapter (and the frontend SSE consumer) can be exercised end to end.
    if (payload.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const id = 'chatcmpl-mock-' + Date.now();
      const created = Math.floor(Date.now() / 1000);
      const words = reply.split(' ');
      for (let i = 0; i < words.length; i++) {
        const delta = i === 0 ? words[i] : ' ' + words[i];
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: payload.model || 'gpt-5-mini',
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      // Final chunk with finish_reason + usage (stream_options.include_usage).
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: payload.model || 'gpt-5-mini',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        })}\n\n`
      );
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const body = {
      id: 'chatcmpl-mock-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: payload.model || 'gpt-5-mini',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: reply },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
    };

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found', path: req.url } }));
});

server.listen(PORT, '127.0.0.1', () => { // security-scan:allow private-url-literal (local loopback bind, not a hardcoded host)
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT} (OpenAI-compatible)`); // security-scan:allow private-url-literal (local loopback bind, not a hardcoded host)
});
