// Targeted verification for audit finding G1 (Fix 2).
// Proves that a DIRECT-provider failure now marks the provider unhealthy,
// while a successful direct call still reports healthy (no regression).
import { createServer } from 'node:http';
import { createLLMRouter } from './backend/llm/providers.mjs';

let mode = 'fail'; // 'fail' | 'ok'

const srv = createServer((req, res) => {
  if (mode === 'fail') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'simulated provider outage' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: 'hello' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});

await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;

const router = createLLMRouter({
  OPENAI_API_KEY: 'test-key',
  OPENAI_API_BASE: `http://127.0.0.1:${port}/v1`, // security-scan:allow private-url-literal
  OPENAI_MODEL: 'gpt-5-mini',
});

const openai = () => router.status().find((p) => p.id === 'openai');
const results = [];
let ok = true;

// --- Test A: direct-provider FAILURE -> throws AND marks unhealthy ----------
mode = 'fail';
let threw = false;
let errMsg = '';
try {
  await router.complete({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] });
} catch (e) {
  threw = true;
  errMsg = e?.message ?? String(e);
}
const afterFail = openai();
const testA = threw && afterFail?.healthy === false;
results.push(['A. direct failure -> throws + healthy:false', testA, `threw=${threw} healthy=${afterFail?.healthy} msg=${errMsg.slice(0, 60)}`]);
if (!testA) ok = false;

// --- Test B: direct-provider SUCCESS -> healthy:true (no regression) --------
mode = 'ok';
let text = null;
try {
  const r = await router.complete({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] });
  text = r.text;
} catch (e) {
  text = `THREW: ${e?.message}`;
}
const afterOk = openai();
const testB = text === 'hello' && afterOk?.healthy === true;
results.push(['B. direct success -> healthy:true', testB, `text=${JSON.stringify(text)} healthy=${afterOk?.healthy}`]);
if (!testB) ok = false;

srv.close();

console.log('=== Fix 2 (G1) verification ===');
for (const [name, pass, detail] of results) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
}
console.log(ok ? 'RESULT: ALL PASS' : 'RESULT: FAILURES PRESENT');
process.exit(ok ? 0 : 1);
