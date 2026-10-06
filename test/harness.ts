/**
 * Node verification harness for the new "real brain + tools + workspace" layer.
 *
 * Run with:  tsx Ai-Semo0o-Agent/test/harness.ts
 *
 * It exercises the pure-logic modules that don't depend on React Native:
 *   • tool-schema compiler (OpenAI / Gemini / Anthropic dialects)
 *   • strict JSON argument validator (+ coercion)
 *   • agentic tool-calling loop (with a scripted provider)
 *   • GitHub URL parser
 *   • ZIP create/extract round-trip
 *   • workspace virtual file system
 *   • cross-platform base64
 */

import {
  toolDefinitionToSchema,
  toOpenAITools,
  toGeminiTools,
  toAnthropicTools,
  normalizeToolChoice,
  validateToolArguments,
  parseAndValidateToolArguments,
} from '../src/services/ai/tool-schema';
import { runToolLoop, type ToolRunner } from '../src/services/ai/tool-loop';
import type { LLMProvider } from '../src/services/ai/provider';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResult,
  ProviderId,
  ToolCall,
} from '../src/types/model';
import type { ToolDefinition } from '../src/types/tool';
import { parseGitHubUrl } from '../src/services/workspace/github';
import { createZip, extractZip } from '../src/services/workspace/zip';
import { WorkspaceService, emptyWorkspace } from '../src/services/workspace/workspace';
import { encodeBase64, decodeBase64, bytesToBase64, base64ToBytes } from '../src/utils/base64';

declare const process: { exit(code?: number): never };

/* -------------------------------------------------------------------------- */
/*  Tiny test runner                                                           */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;

function section(title: string): void {
  console.log(`\n\u25b8 ${title}`);
}

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const sampleTool: ToolDefinition = {
  id: 'demo.echo',
  name: 'Echo',
  nameAr: 'صدى',
  description: 'Echo the given text.',
  descriptionAr: 'يرجع النص كما هو.',
  category: 'system',
  parameters: [
    { name: 'text', type: 'string', description: 'Text to echo', required: true },
    { name: 'times', type: 'number', description: 'Repeat count', default: 1, minimum: 1, maximum: 10 },
    { name: 'mode', type: 'string', description: 'Mode', enumValues: ['plain', 'loud'] },
    { name: 'tags', type: 'array', description: 'Tags', items: 'string' },
  ],
  returns: 'the echoed text',
};

class ScriptedProvider implements LLMProvider {
  id: ProviderId = 'openai';
  live = false;
  calls = 0;
  constructor(private readonly script: ChatCompletionResult[]) {}

  private next(): ChatCompletionResult {
    const result =
      this.script[Math.min(this.calls, this.script.length - 1)] ?? this.script[0];
    this.calls += 1;
    if (!result) {
      throw new Error('ScriptedProvider has no scripted responses');
    }
    return result;
  }

  async complete(_req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    return this.next();
  }

  async *stream(_req: ChatCompletionRequest): AsyncGenerator<ChatCompletionChunk> {
    const result = this.next();
    yield { id: result.id, delta: result.content, done: false, toolCalls: result.toolCalls };
    yield { id: result.id, delta: '', done: true, finishReason: result.finishReason };
  }
}

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

/* -------------------------------------------------------------------------- */
/*  1. Tool-schema compiler                                                    */
/* -------------------------------------------------------------------------- */

function testToolSchema(): void {
  section('Tool-schema compiler');

  const schema = toolDefinitionToSchema(sampleTool);
  check('type is "function"', schema.type === 'function');
  check('function name = tool id', schema.function.name === 'demo.echo');
  check('parameters is an object schema', schema.function.parameters.type === 'object');
  check('additionalProperties === false', schema.function.parameters.additionalProperties === false);
  check(
    'required lists only required params',
    JSON.stringify(schema.function.parameters.required) === JSON.stringify(['text']),
  );
  check('strict defaults to true', schema.function.strict === true);
  check('description prefers Arabic + return contract', /Returns:/.test(schema.function.description));
  const props = schema.function.parameters.properties!;
  check('numeric default forwarded', props.times?.default === 1);
  check('minimum forwarded', props.times?.minimum === 1);
  check(
    'enum forwarded',
    JSON.stringify(props.mode?.enum) === JSON.stringify(['plain', 'loud']),
  );
  check('array items typed', props.tags?.items?.type === 'string');

  const gemini = toGeminiTools([sampleTool]);
  check('gemini returns functionDeclarations', gemini.length === 1 && gemini[0]?.functionDeclarations.length === 1);
  check(
    'gemini types are uppercase',
    gemini[0]?.functionDeclarations[0]?.parameters.properties?.text?.type === 'STRING',
  );

  const anthropic = toAnthropicTools([sampleTool]);
  check('anthropic exposes input_schema', anthropic[0]?.input_schema.type === 'object');
  check('anthropic name matches', anthropic[0]?.name === 'demo.echo');

  check('toolChoice auto', normalizeToolChoice('auto').openai === 'auto');
  check('toolChoice none → gemini NONE', normalizeToolChoice('none').gemini === 'NONE');
  check('toolChoice required → anthropic any', normalizeToolChoice('required').anthropic.type === 'any');
  const named = normalizeToolChoice({ type: 'function', function: { name: 'demo.echo' } });
  check('named toolChoice → openai object', typeof named.openai === 'object');
  check(
    'named toolChoice → gemini allowedFunctionNames',
    JSON.stringify(named.gemini) === JSON.stringify({ mode: 'ANY', allowedFunctionNames: ['demo.echo'] }),
  );
}

/* -------------------------------------------------------------------------- */
/*  2. Strict argument validator                                               */
/* -------------------------------------------------------------------------- */

function testValidator(): void {
  section('Strict argument validator');
  const params = toolDefinitionToSchema(sampleTool).function.parameters;

  let r = validateToolArguments(params, { text: 'hi', times: 3 });
  check('valid args pass', r.ok === true);
  check('valid args preserved', r.value.text === 'hi' && r.value.times === 3);

  r = validateToolArguments(params, { times: 2 });
  check('missing required flagged', r.ok === false && r.issues.some((i) => i.path === 'text'));

  r = validateToolArguments(params, { text: 'hi', times: '7' });
  check('string→number coercion', r.ok === true && r.value.times === 7);

  r = validateToolArguments(params, { text: 'hi', mode: 'zzz' });
  check('enum violation flagged', r.ok === false && r.issues.some((i) => /not one of/.test(i.message)));

  r = validateToolArguments(params, { text: 'hi', extra: 123 });
  check('unknown key dropped (additionalProperties:false)', r.ok === true && !('extra' in r.value));

  r = validateToolArguments(params, { text: 'hi' });
  check('default applied for missing optional', r.value.times === 1);

  r = validateToolArguments(params, { text: 'hi', tags: ['a', 'b'] });
  check('array items validated', r.ok === true && Array.isArray(r.value.tags) && r.value.tags.length === 2);

  r = validateToolArguments(params, { text: 'hi', tags: 'nope' });
  check('array type error flagged', r.ok === false && r.issues.some((i) => i.path === 'tags'));

  const bad = parseAndValidateToolArguments(params, '{ not json');
  check('invalid JSON reported', bad.ok === false && Boolean(bad.parseError));

  const good = parseAndValidateToolArguments(params, JSON.stringify({ text: 'ok' }));
  check('JSON string parsed + validated', good.ok === true && good.value.text === 'ok');
}

/* -------------------------------------------------------------------------- */
/*  3. Agentic tool-calling loop                                               */
/* -------------------------------------------------------------------------- */

async function testToolLoop(): Promise<void> {
  section('Agentic tool-calling loop');

  const toolCall: ToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'demo.echo', arguments: JSON.stringify({ text: 'hello', times: 2 }) },
  };

  const script: ChatCompletionResult[] = [
    { id: 'r1', model: 'm', content: '', usage: USAGE, finishReason: 'tool_calls', toolCalls: [toolCall] },
    { id: 'r2', model: 'm', content: 'Final: hello hello', usage: USAGE, finishReason: 'stop' },
  ];

  const executed: Array<{ toolId: string; args: Record<string, unknown> }> = [];
  const runTool: ToolRunner = async (toolId, args) => {
    executed.push({ toolId, args });
    return { ok: true, output: { echoed: args.text }, logs: ['ok'], durationMs: 1 };
  };

  const loop = await runToolLoop(
    { model: 'm', messages: [{ role: 'user', content: 'echo hello twice' }] },
    { provider: new ScriptedProvider(script), toolSchemas: toOpenAITools([sampleTool]), runTool },
  );
  check('final content returned', loop.content === 'Final: hello hello');
  check('two steps executed', loop.steps === 2);
  check('stopped on final', loop.stopped === 'final');
  check('tool executed exactly once', executed.length === 1 && executed[0]?.toolId === 'demo.echo');
  check('tool received validated args', executed[0]?.args.text === 'hello');
  check('usage accumulated across steps', loop.usage.totalTokens === 30);
  check(
    'tool result fed back as role:tool',
    loop.messages.some((m) => m.role === 'tool' && m.toolCallId === 'call_1'),
  );

  // Unknown tool → not executed, error surfaced, loop still finalises.
  const unknownScript: ChatCompletionResult[] = [
    {
      id: 'r1',
      model: 'm',
      content: '',
      usage: USAGE,
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_x', type: 'function', function: { name: 'nope.tool', arguments: '{}' } }],
    },
    { id: 'r2', model: 'm', content: 'recovered', usage: USAGE, finishReason: 'stop' },
  ];
  let ranUnknown = false;
  const loop2 = await runToolLoop(
    { model: 'm', messages: [{ role: 'user', content: 'x' }] },
    {
      provider: new ScriptedProvider(unknownScript),
      toolSchemas: toOpenAITools([sampleTool]),
      runTool: async () => {
        ranUnknown = true;
        return { ok: true, output: null, durationMs: 0 };
      },
    },
  );
  check('unknown tool never executed', ranUnknown === false);
  check('loop recovers after unknown tool', loop2.content === 'recovered');
  check(
    'unknown tool error surfaced',
    loop2.messages.some((m) => m.role === 'tool' && /unknown tool/.test(m.content)),
  );

  // Invalid args → not executed, validation error surfaced.
  const badScript: ChatCompletionResult[] = [
    {
      id: 'r1',
      model: 'm',
      content: '',
      usage: USAGE,
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_b', type: 'function', function: { name: 'demo.echo', arguments: JSON.stringify({ times: 1 }) } }],
    },
    { id: 'r2', model: 'm', content: 'done', usage: USAGE, finishReason: 'stop' },
  ];
  let ranBad = false;
  const loop3 = await runToolLoop(
    { model: 'm', messages: [{ role: 'user', content: 'x' }] },
    {
      provider: new ScriptedProvider(badScript),
      toolSchemas: toOpenAITools([sampleTool]),
      runTool: async () => {
        ranBad = true;
        return { ok: true, output: null, durationMs: 0 };
      },
    },
  );
  check('invalid args never executed', ranBad === false);
  check(
    'validation error surfaced',
    loop3.messages.some((m) => m.role === 'tool' && /invalid arguments/.test(m.content)),
  );

  // maxSteps budget.
  const alwaysScript: ChatCompletionResult[] = [
    { id: 'r', model: 'm', content: '', usage: USAGE, finishReason: 'tool_calls', toolCalls: [toolCall] },
  ];
  const loop4 = await runToolLoop(
    { model: 'm', messages: [{ role: 'user', content: 'x' }] },
    {
      provider: new ScriptedProvider(alwaysScript),
      toolSchemas: toOpenAITools([sampleTool]),
      runTool: async () => ({ ok: true, output: {}, durationMs: 0 }),
      maxSteps: 3,
    },
  );
  check('maxSteps budget respected', loop4.steps === 3 && loop4.stopped === 'max_steps');
}

/* -------------------------------------------------------------------------- */
/*  4. GitHub URL parser                                                       */
/* -------------------------------------------------------------------------- */

function testGitHubParser(): void {
  section('GitHub URL parser');

  const cases: Array<[string, string | null]> = [
    ['https://github.com/owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['owner/repo', 'owner/repo'],
    ['github.com/owner/repo', 'owner/repo'],
    ['https://github.com/owner/repo/tree/main/src', 'owner/repo'],
    ['https://github.com/owner/repo/blob/main/index.ts', 'owner/repo'],
  ];
  for (const [input, expected] of cases) {
    const ref = parseGitHubUrl(input);
    const got = ref ? `${ref.owner}/${ref.repo}` : null;
    check(`parse "${input}"`, got === expected, `got ${got}`);
  }

  check('tree ref extracted', parseGitHubUrl('https://github.com/owner/repo/tree/dev')?.ref === 'dev');
  check(
    'tree sub-path extracted',
    parseGitHubUrl('https://github.com/owner/repo/tree/main/src/lib')?.path === 'src/lib',
  );
  check('blob ref extracted', parseGitHubUrl('https://github.com/owner/repo/blob/main/index.ts')?.ref === 'main');
  check('invalid input → null', parseGitHubUrl('invalid') === null);
  check('empty input → null', parseGitHubUrl('') === null);
}

/* -------------------------------------------------------------------------- */
/*  5. ZIP round-trip                                                          */
/* -------------------------------------------------------------------------- */

async function testZip(): Promise<void> {
  section('ZIP create / extract round-trip');

  const binaryBytes = new Uint8Array([0, 1, 2, 3, 253, 254, 255]);
  const inputs = [
    { path: 'a.txt', content: 'hello world', encoding: 'utf-8' as const },
    { path: 'src/b.ts', content: 'const x = 1;', encoding: 'utf-8' as const },
    { path: 'img/logo.png', content: bytesToBase64(binaryBytes), encoding: 'base64' as const },
  ];

  const zipBytes = await createZip(inputs);
  check('zip produced non-empty bytes', zipBytes.length > 0);

  const extracted = await extractZip(zipBytes, { stripRootDir: false });
  check('all files extracted', extracted.files.length === 3);
  check('text round-trips', extracted.files.find((f) => f.path === 'a.txt')?.content === 'hello world');
  check('nested path round-trips', extracted.files.find((f) => f.path === 'src/b.ts')?.content === 'const x = 1;');
  const img = extracted.files.find((f) => f.path === 'img/logo.png');
  check('binary detected as base64', img?.encoding === 'base64');
  check('binary bytes round-trip', img?.content === bytesToBase64(binaryBytes));

  const rooted = [
    { path: 'proj/a.txt', content: 'A', encoding: 'utf-8' as const },
    { path: 'proj/b.txt', content: 'B', encoding: 'utf-8' as const },
  ];
  const rootedZip = await createZip(rooted);
  const stripped = await extractZip(rootedZip, { stripRootDir: true });
  check(
    'stripRootDir removes common root',
    stripped.files.map((f) => f.path).sort().join(',') === 'a.txt,b.txt',
  );
}

/* -------------------------------------------------------------------------- */
/*  6. Workspace virtual file system                                           */
/* -------------------------------------------------------------------------- */

async function testWorkspace(): Promise<void> {
  section('Workspace virtual file system');

  const ws = new WorkspaceService(emptyWorkspace('test-ws'));
  ws.addFiles([
    { path: 'src/index.ts', content: 'export const x = 1;', source: 'github', sourceRef: 'o/r' },
    { path: 'README.md', content: '# hi', source: 'github', sourceRef: 'o/r' },
  ]);
  check('addFiles populates', ws.list().length === 2);
  check('imported files not marked modified', ws.read('src/index.ts')?.modified === false);
  check('read returns content', ws.read('src/index.ts')?.content === 'export const x = 1;');
  check('list by prefix', ws.list('src').length === 1);

  ws.write('src/index.ts', 'export const x = 2;');
  check('write updates content', ws.read('src/index.ts')?.content === 'export const x = 2;');
  check('write marks modified', ws.read('src/index.ts')?.modified === true);

  const stats = ws.stats();
  check('stats fileCount', stats.fileCount === 2);
  check('stats modifiedCount', stats.modifiedCount === 1);
  check('stats byExtension', stats.byExtension.ts === 1 && stats.byExtension.md === 1);

  check('delete existing', ws.delete('README.md') === true && ws.list().length === 1);
  check('delete missing → false', ws.delete('nope.txt') === false);

  const wsZip = await ws.exportZip();
  const wsExtracted = await extractZip(wsZip, { stripRootDir: false });
  check('exportZip contains written file', wsExtracted.files.some((f) => f.path === 'src/index.ts'));

  ws.addFiles([{ path: 'lib/util.ts', content: 'export {};', source: 'zip', sourceRef: 'a.zip' }], {
    kind: 'github',
    ref: 'o/r',
  });
  check('addFiles adds new file', ws.read('lib/util.ts')?.source === 'zip');
  check('origin updated', ws.current.origin.kind === 'github');

  const scoped = ws.toZipInputs(['lib/util.ts']);
  check('toZipInputs scopes by path', scoped.length === 1 && scoped[0]?.path === 'lib/util.ts');
}

/* -------------------------------------------------------------------------- */
/*  7. Cross-platform base64                                                   */
/* -------------------------------------------------------------------------- */

function testBase64(): void {
  section('Cross-platform base64');
  const text = 'Hello, عالم! 123 — ✓';
  check('encode/decode UTF-8 round-trip', decodeBase64(encodeBase64(text)) === text);
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  check(
    'bytes → base64 → bytes round-trip',
    JSON.stringify(Array.from(base64ToBytes(bytesToBase64(bytes)))) ===
      JSON.stringify(Array.from(bytes)),
  );
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  console.log('Ai-Semo0o-Agent — verification harness');

  testToolSchema();
  testValidator();
  await testToolLoop();
  testGitHubParser();
  await testZip();
  await testWorkspace();
  testBase64();

  console.log(`\n${'='.repeat(48)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('='.repeat(48));
  if (failed > 0) process.exit(1);
}

void main().catch((error) => {
  console.error('\nHARNESS CRASHED:', error);
  process.exit(1);
});
