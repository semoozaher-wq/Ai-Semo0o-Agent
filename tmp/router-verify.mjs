// Verification harness for the MaestroModelRouter cross-provider fallback.
// Drives the REAL backend/models/task-router.mjs with a mock `llm` (no network).
import { MaestroModelRouter, classifyTask, TASK_TYPE_MODELS } from '/workspace/Ai-Semo0o-Agent/backend/models/task-router.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`); }
}

const router = new MaestroModelRouter();

// 1. Chains span all three families.
console.log('\n[1] Task-type chains span providers');
for (const [tt, chain] of Object.entries(TASK_TYPE_MODELS)) {
  const providers = new Set(chain.map((m) => router.capabilities(m).provider));
  check(`chain(${tt}) spans >=2 providers`, providers.size >= 2, `providers=${[...providers].join(',')}`);
}

// 2. classifyTask works on a code goal.
console.log('\n[2] classifyTask');
check('code goal -> code', classifyTask('fix this bug in my function') === 'code', classifyTask('fix this bug in my function'));
check('vision goal -> vision', classifyTask('describe this image') === 'vision', classifyTask('describe this image'));
check('explicit taskType wins', classifyTask({ taskType: 'reasoning', goal: 'fix a bug' }) === 'reasoning');

// 3. Fallback: first model fails, second succeeds (different provider).
console.log('\n[3] runWithFallback falls through providers');
{
  const chain = router.chain('code');
  const first = chain[0], second = chain[1];
  const calls = [];
  const mock = { complete: async ({ model }) => { calls.push(model); if (model === first) throw new Error('boom-primary'); return { text: 'ok', model }; } };
  const routed = router.createRoutedLLM({ llm: mock, taskType: 'code' });
  const out = await routed.complete({ messages: [{ role: 'user', content: 'x' }] });
  check('returns second model result', out.model === second, `got ${out.model}`);
  check('called first then second', calls[0] === first && calls[1] === second, calls.join('->'));
  check('attempts recorded (fail then ok)', out.routeAttempts?.[0]?.ok === false && out.routeAttempts?.[1]?.ok === true, JSON.stringify(out.routeAttempts));
  check('provider differs across fallback', router.capabilities(first).provider !== router.capabilities(second).provider, `${router.capabilities(first).provider} -> ${router.capabilities(second).provider}`);
}

// 4. Health: failed model marked unhealthy in the shared map.
console.log('\n[4] health tracking after failure');
{
  const r2 = new MaestroModelRouter();
  const chain = r2.chain('reasoning');
  const first = chain[0];
  const mock = { complete: async ({ model }) => { if (model === first) throw new Error('boom'); return { text: 'ok', model }; } };
  const routed = r2.createRoutedLLM({ llm: mock, taskType: 'reasoning' });
  await routed.complete({ messages: [] });
  check('failed model marked unhealthy', r2.health.get(first) === false, `health=${r2.health.get(first)}`);
  const chain2 = r2.chain('reasoning');
  check('unhealthy model dropped from next chain', chain2[0] !== first, `next[0]=${chain2[0]}`);
}

// 5. All models fail -> MAESTRO_ALL_MODELS_FAILED with attempts.
console.log('\n[5] all-models-failed surfaces honestly');
{
  const r3 = new MaestroModelRouter();
  const mock = { complete: async () => { throw new Error('always-down'); } };
  const routed = r3.createRoutedLLM({ llm: mock, taskType: 'fast' });
  let err = null;
  try { await routed.complete({ messages: [] }); } catch (e) { err = e; }
  check('throws MAESTRO_ALL_MODELS_FAILED', err && /MAESTRO_ALL_MODELS_FAILED/.test(err.message), err?.message?.slice(0, 60));
  check('carries attempts[]', Array.isArray(err?.attempts) && err.attempts.length >= 2, `attempts=${err?.attempts?.length}`);
  check('no fake success', err !== null);
}

// 6. fork isolation: one run's failures do not poison another fork.
console.log('\n[6] fork health isolation');
{
  const base = new MaestroModelRouter();
  const chain = base.chain('code');
  const first = chain[0];
  const forkA = base.fork();
  forkA.updateHealth(first, false);
  check('forkA sees unhealthy', forkA.health.get(first) === false);
  check('base unaffected by forkA', base.health.get(first) === undefined, `base=${base.health.get(first)}`);
  const shared = base.fork({ shareHealth: true });
  shared.updateHealth(first, false);
  check('shared fork mutates base map', base.health.get(first) === false, `base=${base.health.get(first)}`);
}

// 7. requires: hard capability filter (fail-closed).
console.log('\n[7] hard capability filter');
{
  const r4 = new MaestroModelRouter();
  const decision = r4.route({ taskType: 'general', requires: { vision: true, tools: true, json: true } });
  check('route returns a model when requirements satisfiable', !!decision.model, decision.model);
  let threw = false;
  try { r4.route({ taskType: 'general', requires: { vision: true }, contextTokens: 10_000_000 }); } catch { threw = true; }
  check('impossible requirement throws NO_HEALTHY_MODEL', threw);
}

console.log(`\n==== ROUTER VERIFY: ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
