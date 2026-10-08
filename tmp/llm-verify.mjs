// Verification-only harness (lives in /tmp, does NOT modify the project).
// Boots a mock OpenAI-compatible endpoint and drives the REAL createLLMRouter
// from backend/llm/providers.mjs to prove: success, transient retry, honest
// failure, and cross-provider model remapping.
import { createServer } from 'node:http';
import { createLLMRouter } from '/workspace/Ai-Semo0o-Agent/backend/llm/providers.mjs';

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`); };

// Mock server with a per-request scripted response queue.
let script = [];
let calls = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls += 1;
    const next = script.shift() || { status: 200, json: { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } } };
    res.writeHead(next.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(next.json ?? {}));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); // security-scan:allow private-url-literal
const base = `http://127.0.0.1:${server.address().port}/v1`; // security-scan:allow private-url-literal

const env = { OPENAI_API_KEY: 'test-key', OPENAI_API_BASE: base, OPENAI_MODEL: 'gpt-5-mini' };

// 1) Happy path
script = [{ status: 200, json: { choices: [{ message: { content: 'hello world' } }], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } } }];
calls = 0;
{
  const router = createLLMRouter(env);
  const out = await router.complete({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] });
  record('provider: happy path returns text', out.text === 'hello world', `text=${out.text} provider=${out.provider} model=${out.model} substituted=${out.substituted}`);
  record('provider: usage parsed', out.usage?.totalTokens === 12, JSON.stringify(out.usage));
}

// 2) Transient 429 then success -> retried (2 retries allowed)
script = [
  { status: 429, json: { error: { message: 'rate limited' } } },
  { status: 200, json: { choices: [{ message: { content: 'after retry' } }] } },
];
calls = 0;
{
  const router = createLLMRouter(env);
  const out = await router.complete({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] });
  record('provider: retries transient 429 then succeeds', out.text === 'after retry' && calls === 2, `calls=${calls} text=${out.text}`);
}

// 3) Persistent 500 -> exhausts retries (3 attempts) and throws honestly
script = [
  { status: 500, json: { error: { message: 'boom' } } },
  { status: 500, json: { error: { message: 'boom' } } },
  { status: 500, json: { error: { message: 'boom' } } },
];
calls = 0;
{
  const router = createLLMRouter(env);
  let err;
  try { await router.complete({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
  record('provider: persistent 500 exhausts retries and throws (no fake success)', Boolean(err) && calls === 3 && /LLM_HTTP_500/.test(err.message), `calls=${calls} err=${err?.code}`);
}

// 4) Non-retryable 400 -> fails fast (1 call), honest error
script = [{ status: 400, json: { error: { message: 'bad request' } } }];
calls = 0;
{
  const router = createLLMRouter(env);
  let err;
  try { await router.complete({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
  record('provider: non-retryable 400 fails fast (1 call)', Boolean(err) && calls === 1 && /LLM_HTTP_400/.test(err.message), `calls=${calls} err=${err?.code}`);
}

// 5) 404 -> LLM_MODEL_NOT_FOUND with actionable hint (no retry)
script = [{ status: 404, json: { error: { message: 'model not found' } } }];
calls = 0;
{
  const router = createLLMRouter(env);
  let err;
  try { await router.complete({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }); } catch (e) { err = e; }
  record('provider: 404 -> LLM_MODEL_NOT_FOUND + hint, no retry', err?.code === 'LLM_MODEL_NOT_FOUND' && Boolean(err.hint) && calls === 1, `calls=${calls} hint=${err?.hint?.slice(0, 40)}`);
}

// 6) Cross-provider remap: request a Gemini model with ONLY OpenAI configured
script = [{ status: 200, json: { choices: [{ message: { content: 'remapped' } }] } }];
calls = 0;
{
  const router = createLLMRouter(env); // openai only
  const out = await router.complete({ model: 'gemini-2.5-flash-lite', messages: [{ role: 'user', content: 'hi' }] });
  record('provider: cross-provider remap (gemini model -> openai, substituted=true)', out.substituted === true && out.provider === 'openai' && out.requestedModel === 'gemini-2.5-flash-lite', `provider=${out.provider} model=${out.model} substituted=${out.substituted}`);
}

// 7) No provider configured -> honest NO_SERVER_LLM_PROVIDER_CONFIGURED
{
  const router = createLLMRouter({});
  let err;
  try { await router.complete({ model: 'gpt-5-mini', messages: [] }); } catch (e) { err = e; }
  record('provider: none configured -> NO_SERVER_LLM_PROVIDER_CONFIGURED', err?.code === 'NO_SERVER_LLM_PROVIDER_CONFIGURED', `err=${err?.code}`);
}

// 8) Health tracking: after failures the provider is marked unhealthy in status()
script = [
  { status: 500, json: {} }, { status: 500, json: {} }, { status: 500, json: {} },
];
{
  const router = createLLMRouter(env);
  try { await router.complete({ model: 'gpt-5-mini', messages: [] }); } catch { /* expected */ }
  const status = router.status();
  record('provider: health() marks provider unhealthy after failure', status[0]?.healthy === false, JSON.stringify(status));
}

server.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\nRESULT: ${results.length - failed}/${results.length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
