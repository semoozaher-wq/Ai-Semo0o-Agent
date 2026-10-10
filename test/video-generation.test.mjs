import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createVideoProvider,
  createVideoEditProvider,
  connectorStatus,
} from '../tools/connectors.mjs';
import {
  createVideoGenerationService,
  conversationalVideoEdit,
  normalizeVideoInput,
} from '../creation/video-gen.mjs';
import { createLocalOnlyProviders, runDirector } from '../creation/index.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

/**
 * Real AI video generation — exercised end to end over a REAL local HTTP server
 * (actual TCP round-trips), not a stubbed `fetch`. This proves:
 *   - the Veo (Gemini API) long-running flow (predictLongRunning → poll →
 *     download) really produces bytes;
 *   - image-to-video attaches the source frame;
 *   - video editing routes to a genuine video-to-video provider;
 *   - the conversational editor interprets a conversation and routes honestly;
 *   - every path fails closed (no fake success) with no configuration.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-video-'));

// A minimal, well-formed MP4 header so sniffMediaType() classifies it as video.
const mp4Bytes = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(64, 7)]);

function startServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const record = { method: req.method, url: req.url, headers: req.headers, body };
        requests.push(record);
        handler(record, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, requests, url: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

const VIDEO_ENV = [
  'VIDEO_PROVIDER', 'VIDEO_API_KEY', 'VIDEO_API_BASE', 'VIDEO_MODEL', 'VIDEO_MAX_POLLS', 'VIDEO_POLL_MS',
  'VIDEO_HTTP_URL', 'VIDEO_HTTP_SECRET', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_BASE',
  'VIDEO_EDIT_PROVIDER', 'VIDEO_EDIT_HTTP_URL', 'VIDEO_EDIT_HTTP_SECRET',
  'REPLICATE_API_TOKEN', 'REPLICATE_API_BASE', 'REPLICATE_VIDEO_VERSION', 'REPLICATE_VIDEO_MODEL',
  'REPLICATE_VIDEO_EDIT_VERSION', 'REPLICATE_VIDEO_EDIT_MODEL', 'REPLICATE_MAX_POLLS', 'REPLICATE_POLL_MS',
];

async function withEnv(vars, fn) {
  const keys = new Set([...VIDEO_ENV, ...Object.keys(vars)]);
  const snapshot = new Map();
  for (const key of keys) {
    snapshot.set(key, process.env[key]);
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Veo (Gemini API) text-to-video                                             */
/* -------------------------------------------------------------------------- */

test('Veo text-to-video: predictLongRunning → poll → download produces real bytes', async () => {
  const mp4 = mp4Bytes();
  let polls = 0;
  const srv = await startServer((req, res) => {
    if (req.url.endsWith(':predictLongRunning')) return json(res, 200, { name: 'operations/op-1' });
    if (req.url === '/v1beta/operations/op-1') {
      polls += 1;
      if (polls < 2) return json(res, 200, { name: 'operations/op-1', done: false });
      return json(res, 200, { name: 'operations/op-1', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${srv.url}/out.mp4` } }] } } });
    }
    if (req.url === '/out.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(mp4); }
    return json(res, 404, { error: 'not found' });
  });
  try {
    await withEnv({ VIDEO_PROVIDER: 'google', VIDEO_API_KEY: 'test-key', VIDEO_API_BASE: `${srv.url}/v1beta`, VIDEO_MODEL: 'veo-3.1-generate-001', VIDEO_POLL_MS: '1', VIDEO_MAX_POLLS: '10' }, async () => {
      const provider = createVideoProvider();
      assert.equal(provider.id, 'google');
      assert.equal(provider.model, 'veo-3.1-generate-001');
      assert.equal(provider.capabilities.textToVideo, true);
      assert.equal(provider.capabilities.imageToVideo, true);
      assert.equal(provider.capabilities.videoExtension, true);
      assert.equal(provider.capabilities.videoEditing, false);
      const result = await provider.generate({ prompt: 'a cat surfing a big wave', durationSeconds: 5, aspectRatio: '16:9' });
      assert.equal(result.mimeType, 'video/mp4');
      assert.equal(Buffer.from(result.base64, 'base64').length, mp4.length);
      assert.ok(polls >= 2, 'the operation was polled until done');
      const startReq = srv.requests.find((r) => r.url.endsWith(':predictLongRunning'));
      assert.equal(startReq.headers['x-goog-api-key'], 'test-key');
      const body = JSON.parse(startReq.body.toString());
      assert.equal(body.instances[0].prompt, 'a cat surfing a big wave');
      assert.equal(body.parameters.durationSeconds, 5);
      assert.equal(body.parameters.aspectRatio, '16:9');
    });
  } finally { await srv.close(); }
});

test('Veo image-to-video attaches the source frame as inlineData', async () => {
  const mp4 = mp4Bytes();
  const srv = await startServer((req, res) => {
    if (req.url.endsWith(':predictLongRunning')) return json(res, 200, { name: 'operations/op-2' });
    if (req.url === '/v1beta/operations/op-2') return json(res, 200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${srv.url}/out.mp4` } }] } } });
    if (req.url === '/out.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(mp4); }
    return json(res, 404, {});
  });
  try {
    await withEnv({ VIDEO_PROVIDER: 'google', VIDEO_API_KEY: 'k', VIDEO_API_BASE: `${srv.url}/v1beta`, VIDEO_POLL_MS: '1' }, async () => {
      const service = createVideoGenerationService();
      const result = await service.imageToVideo({ prompt: 'gently animate the scene', image: { base64: 'QUJD', mimeType: 'image/png' } });
      assert.equal(Buffer.from(result.base64, 'base64').length, mp4.length);
      const startReq = srv.requests.find((r) => r.url.endsWith(':predictLongRunning'));
      const body = JSON.parse(startReq.body.toString());
      assert.equal(body.instances[0].image.inlineData.data, 'QUJD');
      assert.equal(body.instances[0].image.inlineData.mimeType, 'image/png');
    });
  } finally { await srv.close(); }
});

test('Veo video extension attaches the source clip (video-to-video continuation)', async () => {
  const mp4 = mp4Bytes();
  const srv = await startServer((req, res) => {
    if (req.url.endsWith(':predictLongRunning')) return json(res, 200, { name: 'operations/op-3' });
    if (req.url === '/v1beta/operations/op-3') return json(res, 200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${srv.url}/out.mp4` } }] } } });
    if (req.url === '/out.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(mp4); }
    return json(res, 404, {});
  });
  try {
    await withEnv({ VIDEO_PROVIDER: 'google', VIDEO_API_KEY: 'k', VIDEO_API_BASE: `${srv.url}/v1beta`, VIDEO_POLL_MS: '1' }, async () => {
      const service = createVideoGenerationService();
      assert.equal(service.capabilities.videoExtension, true);
      const result = await service.extendVideo({ prompt: 'continue the shot', video: { base64: 'VklE', mimeType: 'video/mp4' } });
      assert.equal(Buffer.from(result.base64, 'base64').length, mp4.length);
      const startReq = srv.requests.find((r) => r.url.endsWith(':predictLongRunning'));
      const body = JSON.parse(startReq.body.toString());
      assert.equal(body.instances[0].video.inlineData.data, 'VklE');
    });
  } finally { await srv.close(); }
});

/* -------------------------------------------------------------------------- */
/* Genuine video editing (video-to-video)                                     */
/* -------------------------------------------------------------------------- */

test('video.edit (http) posts the source clip + instruction and returns edited bytes', async () => {
  const edited = mp4Bytes();
  const srv = await startServer((req, res) => {
    if (req.url === '/edit') return json(res, 200, { video: { base64: edited.toString('base64'), mimeType: 'video/mp4' } });
    return json(res, 404, {});
  });
  try {
    await withEnv({ VIDEO_EDIT_PROVIDER: 'http', VIDEO_EDIT_HTTP_URL: `${srv.url}/edit`, VIDEO_EDIT_HTTP_SECRET: 'edit-secret' }, async () => {
      const editor = createVideoEditProvider();
      assert.ok(editor);
      const result = await editor.edit({ video: { base64: 'VklE', mimeType: 'video/mp4' }, prompt: 'make the scene snowy' });
      assert.equal(Buffer.from(result.base64, 'base64').length, edited.length);
      const req = srv.requests[0];
      assert.equal(req.headers['x-connector-signature'], 'edit-secret');
      const body = JSON.parse(req.body.toString());
      assert.equal(body.video.base64, 'VklE');
      assert.equal(body.prompt, 'make the scene snowy');
    });
  } finally { await srv.close(); }
});

test('video.edit (replicate) runs a prediction with a data-URI video input', async () => {
  const edited = mp4Bytes();
  const srv = await startServer((req, res) => {
    if (req.url === '/v1/predictions' && req.method === 'POST') return json(res, 200, { id: 'pred-1', status: 'succeeded', output: `${srv.url}/edited.mp4` });
    if (req.url === '/edited.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(edited); }
    return json(res, 404, {});
  });
  try {
    await withEnv({ REPLICATE_API_TOKEN: 'r8_test', REPLICATE_API_BASE: `${srv.url}/v1`, REPLICATE_VIDEO_EDIT_VERSION: 'abc123' }, async () => {
      const editor = createVideoEditProvider();
      assert.equal(editor.id, 'replicate');
      const result = await editor.edit({ video: { base64: 'VklE', mimeType: 'video/mp4' }, prompt: 'restyle as anime' });
      assert.equal(Buffer.from(result.base64, 'base64').length, edited.length);
      const body = JSON.parse(srv.requests[0].body.toString());
      assert.match(body.input.video, /^data:video\/mp4;base64,VklE$/);
      assert.equal(body.input.prompt, 'restyle as anime');
    });
  } finally { await srv.close(); }
});

/* -------------------------------------------------------------------------- */
/* Conversational video editing                                               */
/* -------------------------------------------------------------------------- */

test('conversationalVideoEdit interprets the conversation and routes to a genuine editor', async () => {
  const edited = mp4Bytes();
  const srv = await startServer((req, res) => {
    if (req.url === '/edit') return json(res, 200, { video: { base64: edited.toString('base64'), mimeType: 'video/mp4' } });
    return json(res, 404, {});
  });
  const fakeLlm = { async complete() { return { text: '{"operation":"edit","instruction":"re-light the scene at golden hour"}' }; } };
  try {
    const result = await conversationalVideoEdit({
      conversation: [
        { role: 'user', content: 'can you make it look like sunset?' },
        { role: 'assistant', content: 'sure, warm golden hour light' },
        { role: 'user', content: 'yes do that' },
      ],
      sourceVideo: { base64: 'VklE', mimeType: 'video/mp4' },
      llm: fakeLlm,
      env: { VIDEO_EDIT_PROVIDER: 'http', VIDEO_EDIT_HTTP_URL: `${srv.url}/edit` },
    });
    assert.equal(result.operation, 'edit');
    assert.equal(result.instruction, 're-light the scene at golden hour');
    assert.equal(result.plan.source, 'llm');
    assert.equal(Buffer.from(result.base64, 'base64').length, edited.length);
  } finally { await srv.close(); }
});

test('conversationalVideoEdit falls back deterministically with no LLM', async () => {
  const edited = mp4Bytes();
  const srv = await startServer((req, res) => {
    if (req.url === '/edit') return json(res, 200, { video: { base64: edited.toString('base64'), mimeType: 'video/mp4' } });
    return json(res, 404, {});
  });
  try {
    const result = await conversationalVideoEdit({
      conversation: 'please change the background to a snowy forest',
      sourceVideo: { base64: 'VklE' },
      env: { VIDEO_EDIT_PROVIDER: 'http', VIDEO_EDIT_HTTP_URL: `${srv.url}/edit` },
    });
    assert.equal(result.operation, 'edit');
    assert.equal(result.plan.source, 'deterministic');
    assert.match(result.instruction, /snowy forest/);
  } finally { await srv.close(); }
});

test('conversationalVideoEdit fails closed when no genuine editor is configured', async () => {
  await withEnv({ VIDEO_PROVIDER: 'google', VIDEO_API_KEY: 'k' }, async () => {
    await assert.rejects(
      () => conversationalVideoEdit({ conversation: 'make it snowy', sourceVideo: { base64: 'VklE' } }),
      /VIDEO_EDIT_UNSUPPORTED/,
    );
  });
});

test('conversationalVideoEdit routes an explicit "extend" request to Veo extension', async () => {
  const mp4 = mp4Bytes();
  const srv = await startServer((req, res) => {
    if (req.url.endsWith(':predictLongRunning')) return json(res, 200, { name: 'operations/ext' });
    if (req.url === '/v1beta/operations/ext') return json(res, 200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${srv.url}/out.mp4` } }] } } });
    if (req.url === '/out.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(mp4); }
    return json(res, 404, {});
  });
  try {
    const result = await conversationalVideoEdit({
      conversation: 'extend this clip by a few seconds',
      sourceVideo: { base64: 'VklE', mimeType: 'video/mp4' },
      env: { VIDEO_PROVIDER: 'google', VIDEO_API_KEY: 'k', VIDEO_API_BASE: `${srv.url}/v1beta`, VIDEO_POLL_MS: '1' },
    });
    assert.equal(result.operation, 'extend');
    assert.equal(Buffer.from(result.base64, 'base64').length, mp4.length);
  } finally { await srv.close(); }
});

/* -------------------------------------------------------------------------- */
/* Capabilities & fail-closed                                                 */
/* -------------------------------------------------------------------------- */

test('video generation fails closed with no configuration (no fake success)', async () => {
  await withEnv({}, async () => {
    assert.equal(createVideoProvider(), null);
    assert.equal(createVideoEditProvider(), null);
    const service = createVideoGenerationService();
    assert.deepEqual(service.capabilities, { textToVideo: false, imageToVideo: false, videoExtension: false, videoEditing: false });
    await assert.rejects(() => service.textToVideo({ prompt: 'x' }), /TOOL_CONNECTOR_NOT_CONFIGURED:video\.generate/);
    await assert.rejects(() => service.editVideo({ prompt: 'x', video: { base64: 'VklE' } }), /TOOL_CONNECTOR_NOT_CONFIGURED:video\.edit/);
    const status = connectorStatus();
    assert.equal(status.video, false);
    assert.equal(status.videoEdit, false);
  });
});

test('normalizeVideoInput keeps only well-formed media and bounded fields', () => {
  const out = normalizeVideoInput({
    prompt: 'p', durationSeconds: '5', image: { base64: 'AAA' }, video: { base64: 'VVV' }, junk: 1,
  });
  assert.equal(out.prompt, 'p');
  assert.equal(out.durationSeconds, 5);
  assert.equal(out.image.mimeType, 'image/png');
  assert.equal(out.video.mimeType, 'video/mp4');
  assert.equal('junk' in out, false);
});

/* -------------------------------------------------------------------------- */
/* Registry tools (real workspace writes)                                     */
/* -------------------------------------------------------------------------- */

test('registry: video.generate and video.imageToVideo write real files', async () => {
  const mp4 = mp4Bytes();
  const dir = await temp();
  const srv = await startServer((req, res) => {
    if (req.url.endsWith(':predictLongRunning')) return json(res, 200, { name: 'operations/reg' });
    if (req.url === '/v1beta/operations/reg') return json(res, 200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${srv.url}/out.mp4` } }] } } });
    if (req.url === '/out.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(mp4); }
    return json(res, 404, {});
  });
  try {
    await withEnv({ VIDEO_PROVIDER: 'google', VIDEO_API_KEY: 'k', VIDEO_API_BASE: `${srv.url}/v1beta`, VIDEO_POLL_MS: '1' }, async () => {
      const registry = createLiveToolRegistry();
      const t2v = await registry.run('video.generate', { prompt: 'a lighthouse at dawn', path: 'out/t2v.mp4' }, { workspaceRoot: dir });
      assert.equal(t2v.output.bytes, mp4.length);
      assert.equal(t2v.output.provider, 'google');
      assert.equal((await readFile(path.join(dir, 'out/t2v.mp4'))).length, mp4.length);

      // image-to-video needs a real source image on disk.
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(path.join(dir, 'src.png'), png);
      const i2v = await registry.run('video.imageToVideo', { imagePath: 'src.png', prompt: 'animate gently', path: 'out/i2v.mp4' }, { workspaceRoot: dir });
      assert.equal(i2v.output.bytes, mp4.length);
      const startReq = srv.requests.filter((r) => r.url.endsWith(':predictLongRunning')).pop();
      const body = JSON.parse(startReq.body.toString());
      assert.ok(body.instances[0].image, 'the source image reached the provider');
    });
  } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
});

test('registry: video.edit writes an edited file when an editor is configured', async () => {
  const edited = mp4Bytes();
  const dir = await temp();
  const srv = await startServer((req, res) => {
    if (req.url === '/edit') return json(res, 200, { video: { base64: edited.toString('base64'), mimeType: 'video/mp4' } });
    return json(res, 404, {});
  });
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'src.mp4'), mp4Bytes());
    await withEnv({ VIDEO_EDIT_PROVIDER: 'http', VIDEO_EDIT_HTTP_URL: `${srv.url}/edit` }, async () => {
      const registry = createLiveToolRegistry();
      const out = await registry.run('video.edit', { videoPath: 'src.mp4', instruction: 'change the sky to aurora', path: 'out/edited.mp4' }, { workspaceRoot: dir });
      assert.equal(out.output.bytes, edited.length);
      assert.equal(out.output.operation, 'edit');
      assert.equal((await readFile(path.join(dir, 'out/edited.mp4'))).length, edited.length);
    });
  } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
});

/* -------------------------------------------------------------------------- */
/* Director real-video stage (additive)                                       */
/* -------------------------------------------------------------------------- */

test('director: realVideo produces a real MP4 via the configured provider', async () => {
  const mp4 = mp4Bytes();
  const local = createLocalOnlyProviders();
  const providers = {
    ...local,
    video: {
      id: 'fake',
      model: 'fake-video',
      capabilities: { textToVideo: true, imageToVideo: false, videoExtension: false, videoEditing: false },
      async generate() { return { provider: 'fake', model: 'fake-video', mimeType: 'video/mp4', base64: mp4.toString('base64') }; },
    },
    capabilities: { ...local.capabilities, video: true },
  };
  const events = [];
  const out = await runDirector('a short promo for a smart water bottle', {
    resolution: 'draft', fps: 6, duration: 4, formats: false, bundle: false,
    realVideo: true,
    providers,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  assert.ok(out.media.mp4, 'a real MP4 was produced');
  assert.equal(out.media.mp4.length, mp4.length);
  assert.equal(out.manifest.realVideo, true);
  assert.equal(out.manifest.videoProvider, 'fake');
  assert.equal(out.manifest.videoModel, 'fake-video');
  assert.ok(events.some((e) => e.type === 'video_done'));
});

test('director: a failing real-video provider is reported, never faked', async () => {
  const local = createLocalOnlyProviders();
  const providers = {
    ...local,
    video: {
      id: 'broken', model: 'broken-video', capabilities: { textToVideo: true },
      async generate() { throw new Error('PROVIDER_DOWN'); },
    },
    capabilities: { ...local.capabilities, video: true },
  };
  const out = await runDirector('promo', {
    resolution: 'draft', fps: 6, duration: 4, formats: false, bundle: false,
    realVideo: true, providers,
  });
  assert.equal(out.media.mp4, undefined);
  assert.equal(out.manifest.realVideo, false);
  assert.equal(out.manifest.videoError, 'PROVIDER_DOWN');
  assert.ok(out.media.gif === undefined); // deterministic artefacts still absent because formats:false
});
