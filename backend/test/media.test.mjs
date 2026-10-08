import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  sniffMediaType, probeMedia, encodeWav, decodeWav, generateTone,
} from '../media/media.mjs';
import {
  createSpeechToTextProvider, createTextToSpeechProvider, createVideoProvider,
  createAudioProvider, createMediaAnalysisProvider, connectorStatus,
} from '../tools/connectors.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';
import { Database, id, now } from '../db/client.mjs';

/**
 * Media & multimodal: the local half (sniff/probe/WAV codec) is exercised with
 * real buffers; the provider half is exercised over a REAL local HTTP server so
 * the wiring is proven end to end (multipart upload, binary download, URL
 * fetch), and a missing provider stays fail-closed with no fake success.
 */

const temp = () => mkdtemp(path.join(os.tmpdir(), 'semo0o-media-'));

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

const ALL_MEDIA_ENV = [
  'STT_API_KEY', 'STT_API_BASE', 'STT_PROVIDER', 'STT_HTTP_URL', 'STT_HTTP_SECRET',
  'TTS_API_KEY', 'TTS_API_BASE', 'TTS_PROVIDER', 'TTS_HTTP_URL', 'TTS_HTTP_SECRET',
  'VIDEO_PROVIDER', 'VIDEO_HTTP_URL', 'VIDEO_HTTP_SECRET',
  'AUDIO_PROVIDER', 'AUDIO_HTTP_URL', 'AUDIO_HTTP_SECRET',
  'MEDIA_ANALYZE_HTTP_URL', 'MEDIA_ANALYZE_HTTP_SECRET',
  'VISION_API_KEY', 'VISION_API_BASE', 'VISION_PROVIDER',
  'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ELEVENLABS_API_KEY', 'REPLICATE_API_TOKEN',
];

async function withEnv(vars, fn) {
  const keys = new Set([...ALL_MEDIA_ENV, ...Object.keys(vars)]);
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

const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

/* -------------------------------------------------------------------------- */
/*  Local media processing                                                    */
/* -------------------------------------------------------------------------- */

test('sniffMediaType identifies real container magic bytes', () => {
  assert.equal(sniffMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])).format, 'png');
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])).format, 'jpeg');
  assert.equal(sniffMediaType(Buffer.from('GIF89a123456', 'ascii')).format, 'gif');
  assert.equal(sniffMediaType(Buffer.from('RIFF....WAVE', 'ascii')).format, 'wav');
  assert.equal(sniffMediaType(Buffer.from('OggS........', 'ascii')).format, 'ogg');
  assert.equal(sniffMediaType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])).format, 'webm');
  const mp4 = Buffer.alloc(16); mp4.write('....ftypisom', 0, 'ascii');
  assert.equal(sniffMediaType(mp4).format, 'mp4');
  assert.equal(sniffMediaType(Buffer.from('not media at all')).kind, 'unknown');
});

test('probeMedia reads PNG/JPEG/GIF dimensions and WAV metadata', () => {
  const png = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.deepEqual([probeMedia(png).width, probeMedia(png).height], [640, 480]);

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([probeMedia(jpeg).width, probeMedia(jpeg).height], [200, 100]);

  const gif = Buffer.alloc(13);
  gif.write('GIF89a', 0, 'ascii'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(240, 8);
  assert.deepEqual([probeMedia(gif).width, probeMedia(gif).height], [320, 240]);

  const wav = encodeWav({ samples: generateTone({ frequency: 220, durationSeconds: 0.25, sampleRate: 16000 }), sampleRate: 16000, channels: 1, bitsPerSample: 16 });
  const info = probeMedia(wav);
  assert.equal(info.kind, 'audio');
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.channels, 1);
  assert.ok(Math.abs(info.durationSeconds - 0.25) < 0.001);
});

test('encodeWav / decodeWav round-trips PCM samples faithfully', () => {
  const tone = generateTone({ frequency: 440, durationSeconds: 0.1, sampleRate: 8000, amplitude: 0.8 });
  const wav = encodeWav({ samples: tone, sampleRate: 8000, channels: 1, bitsPerSample: 16 });
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  const decoded = decodeWav(wav);
  assert.equal(decoded.samples.length, tone.length);
  assert.equal(decoded.sampleRate, 8000);
  // 16-bit quantization error stays well under 1/32767 per sample.
  let maxError = 0;
  for (let i = 0; i < tone.length; i += 1) maxError = Math.max(maxError, Math.abs(tone[i] - decoded.samples[i]));
  assert.ok(maxError < 0.001, `max quantization error ${maxError}`);
});

test('decodeWav rejects a non-WAVE buffer', () => {
  assert.throws(() => decodeWav(Buffer.from('RIFF....WAVE')).message, /WAV_INVALID/);
});

/* -------------------------------------------------------------------------- */
/*  Provider adapters over a real HTTP server                                 */
/* -------------------------------------------------------------------------- */

test('speech.transcribe (OpenAI shape) uploads multipart audio and returns text', async () => {
  const srv = await startServer((_req, res) => json(res, 200, { text: 'hello world', language: 'en', duration: 1.2 }));
  try {
    await withEnv({ STT_PROVIDER: 'openai', STT_API_KEY: 'sk-test', STT_API_BASE: srv.url }, async () => {
      const provider = createSpeechToTextProvider();
      assert.equal(provider.id, 'openai');
      const result = await provider.transcribe({ base64: Buffer.from('RIFF....WAVE').toString('base64'), mimeType: 'audio/wav', language: 'en' });
      assert.equal(result.text, 'hello world');
      assert.equal(result.duration, 1.2);
      const req = srv.requests[0];
      assert.equal(req.url, '/audio/transcriptions');
      assert.match(String(req.headers['content-type']), /multipart\/form-data/);
      assert.match(req.body.toString('utf8'), /name="model"/);
    });
  } finally { await srv.close(); }
});

test('speech.synthesize (OpenAI shape) downloads binary audio', async () => {
  const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200, 7)]);
  const srv = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(mp3); });
  try {
    await withEnv({ TTS_PROVIDER: 'openai', TTS_API_KEY: 'sk-test', TTS_API_BASE: srv.url }, async () => {
      const provider = createTextToSpeechProvider();
      const result = await provider.synthesize({ text: 'hi there' });
      assert.equal(result.mimeType, 'audio/mpeg');
      assert.equal(Buffer.from(result.base64, 'base64').length, mp3.length);
      assert.equal(srv.requests[0].url, '/audio/speech');
    });
  } finally { await srv.close(); }
});

test('video.generate (http) fetches a URL payload and returns bytes', async () => {
  const videoBytes = Buffer.concat([Buffer.alloc(4), Buffer.from('....ftypisom', 'ascii'), Buffer.alloc(64, 3)]);
  const srv = await startServer((req, res) => {
    if (req.url === '/generate') return json(res, 200, { video: { url: `${srv.url}/asset.mp4` } });
    res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(videoBytes);
  });
  try {
    await withEnv({ VIDEO_PROVIDER: 'http', VIDEO_HTTP_URL: `${srv.url}/generate` }, async () => {
      const provider = createVideoProvider();
      const result = await provider.generate({ prompt: 'a cat surfing' });
      assert.equal(result.mimeType, 'video/mp4');
      assert.equal(Buffer.from(result.base64, 'base64').length, videoBytes.length);
    });
  } finally { await srv.close(); }
});

test('audio.generate (http) accepts inline base64', async () => {
  const srv = await startServer((_req, res) => json(res, 200, { audio: { base64: Buffer.from('RIFF....WAVE').toString('base64'), mimeType: 'audio/wav' } }));
  try {
    await withEnv({ AUDIO_PROVIDER: 'http', AUDIO_HTTP_URL: srv.url }, async () => {
      const provider = createAudioProvider();
      const result = await provider.generate({ prompt: 'lo-fi beat' });
      assert.equal(result.mimeType, 'audio/wav');
    });
  } finally { await srv.close(); }
});

test('media.analyze provider posts media and returns an analysis', async () => {
  const srv = await startServer((_req, res) => json(res, 200, { text: 'a dog barking', model: 'm1' }));
  try {
    await withEnv({ MEDIA_ANALYZE_HTTP_URL: srv.url }, async () => {
      const provider = createMediaAnalysisProvider();
      const result = await provider.analyze({ base64: 'AAAA', mimeType: 'audio/wav', kind: 'audio', prompt: 'what is this' });
      assert.equal(result.text, 'a dog barking');
      assert.match(srv.requests[0].body.toString('utf8'), /"kind":"audio"/);
    });
  } finally { await srv.close(); }
});

test('every media provider fails closed (returns null) with no configuration', async () => {
  await withEnv({}, async () => {
    assert.equal(createSpeechToTextProvider(), null);
    assert.equal(createTextToSpeechProvider(), null);
    assert.equal(createVideoProvider(), null);
    assert.equal(createAudioProvider(), null);
    assert.equal(createMediaAnalysisProvider(), null);
    const status = connectorStatus();
    assert.equal(status.stt, false);
    assert.equal(status.tts, false);
    assert.equal(status.video, false);
    assert.equal(status.audio, false);
    assert.equal(status.mediaAnalysis, false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Registry integration                                                      */
/* -------------------------------------------------------------------------- */

function seedRun(db) {
  const t = now();
  const tenantId = id('tenant'); const userId = id('user'); const projectId = id('project');
  const workspaceId = id('workspace'); const taskId = id('task'); const runId = id('run');
  db.run('INSERT INTO tenants(id,name,created_at) VALUES(?,?,?)', tenantId, 'T', t);
  db.run('INSERT INTO users(id,tenant_id,email,password_hash,role,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, 'a@t', 'x', 'owner', t);
  db.run('INSERT INTO projects(id,tenant_id,owner_id,name,created_at) VALUES(?,?,?,?,?)', projectId, tenantId, userId, 'P', t);
  db.run('INSERT INTO workspaces(id,project_id,root_path,created_at) VALUES(?,?,?,?)', workspaceId, projectId, process.cwd(), t);
  db.run('INSERT INTO tasks(id,tenant_id,project_id,workspace_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', taskId, tenantId, projectId, workspaceId, userId, 'g', 'running', t, t);
  db.run('INSERT INTO runs(id,task_id,tenant_id,status,payload_json,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', runId, taskId, tenantId, 'running', '{}', 0, t, t);
  return { runId };
}

test('registry: media.probe is live and reads a real file; provider tools stay unwired without config', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'm.sqlite'));
    const registry = createLiveToolRegistry({ db, codeRunner: null, tavily: null, llm: null, engineAvailable: true, memory: null });
    const wav = encodeWav({ samples: generateTone({ frequency: 440, durationSeconds: 0.2, sampleRate: 16000 }), sampleRate: 16000 });
    await writeFile(path.join(dir, 'tone.wav'), wav);

    const probe = await registry.run('media.probe', { path: 'tone.wav' }, { workspaceRoot: dir });
    assert.equal(probe.output.kind, 'audio');
    assert.equal(probe.output.sampleRate, 16000);

    const status = registry.status();
    assert.ok(status.live.includes('media.probe'));
    assert.ok(status.unwired.includes('speech.transcribe'));
    assert.ok(status.unwired.includes('video.generate'));

    await assert.rejects(() => registry.run('speech.transcribe', { path: 'tone.wav' }, { workspaceRoot: dir }), /TOOL_CONNECTOR_NOT_CONFIGURED:speech\.transcribe/);
    await assert.rejects(() => registry.run('video.generate', { prompt: 'x' }, { workspaceRoot: dir }), /TOOL_CONNECTOR_NOT_CONFIGURED:video\.generate/);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('registry: speech.synthesize writes a real audio file and records an artifact', async () => {
  const dir = await temp();
  try {
    const db = new Database(path.join(dir, 'm.sqlite'));
    const { runId } = seedRun(db);
    const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(128, 9)]);
    const srv = await startServer((_req, res) => { res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(mp3); });
    try {
      await withEnv({ TTS_PROVIDER: 'openai', TTS_API_KEY: 'sk-test', TTS_API_BASE: srv.url }, async () => {
        const registry = createLiveToolRegistry({ db, codeRunner: null, tavily: null, llm: null, engineAvailable: true, memory: null });
        const result = await registry.run('speech.synthesize', { text: 'hello from the agent', path: 'out/speech.mp3' }, { workspaceRoot: dir, run: { id: runId, tenant_id: 'x' } });
        assert.equal(result.output.path, 'out/speech.mp3');
        assert.ok(result.output.artifact && result.output.artifact.id);
        const written = await readFile(path.join(dir, 'out/speech.mp3'));
        assert.equal(written.length, mp3.length);
        const row = db.get('SELECT path, kind, mime_type, size_bytes FROM artifacts WHERE run_id=?', runId);
        assert.equal(row.path, 'out/speech.mp3');
        assert.equal(row.kind, 'audio');
        assert.equal(row.mime_type, 'audio/mpeg');
      });
    } finally { await srv.close(); }
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
