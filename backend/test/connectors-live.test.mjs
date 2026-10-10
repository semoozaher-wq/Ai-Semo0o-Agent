import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createImageProvider, createCalendarProvider, createEmailSendProvider, createSlackProvider, createTeamsProvider, createDiscordProvider, createNotionProvider, createWebhookProvider, connectorStatus } from '../tools/connectors.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

/**
 * These tests exercise the connectors over a REAL local HTTP server (actual TCP
 * round-trips), not a stubbed `fetch`. That is the only way to prove the wiring
 * truly works end to end and that a missing credential stays fail-closed with
 * no fake success.
 */

function startServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
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

/** Run `fn` with a patched process.env, restoring every key afterwards. */
async function withEnv(vars, fn) {
  const snapshot = new Map();
  for (const key of Object.keys(vars)) {
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

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

/* -------------------------------------------------------------------------- */

test('email.send delivers over a real HTTP webhook and reports the provider id', async () => {
  const srv = await startServer((_req, res) => json(res, 200, { id: 'msg_live_1' }));
  try {
    const output = await withEnv(
      { EMAIL_PROVIDER: 'webhook', EMAIL_WEBHOOK_URL: `${srv.url}/send`, EMAIL_WEBHOOK_SECRET: 'whsec_live_value' },
      async () => {
        const registry = createLiveToolRegistry();
        assert.equal(registry.status().tools.find((t) => t.id === 'email.send').state, 'live');
        return registry.run('email.send', { to: 'user@example.test', subject: 'Hi', body: 'Hello' });
      },
    );
    assert.equal(output.output.delivered, true);
    assert.equal(output.output.messageId, 'msg_live_1');
    assert.equal(srv.requests.length, 1);
    assert.equal(srv.requests[0].method, 'POST');
    assert.equal(srv.requests[0].headers['x-connector-signature'], 'whsec_live_value');
    assert.match(srv.requests[0].body, /user@example\.test/);
  } finally {
    await srv.close();
  }
});

test('calendar.schedule delivers over a real HTTP webhook', async () => {
  const srv = await startServer((_req, res) => json(res, 200, { id: 'evt_live_9', status: 'accepted' }));
  try {
    const output = await withEnv(
      { CALENDAR_PROVIDER: 'webhook', CALENDAR_WEBHOOK_URL: `${srv.url}/hook` },
      async () => {
        const registry = createLiveToolRegistry();
        assert.equal(registry.status().tools.find((t) => t.id === 'calendar.schedule').state, 'live');
        return registry.run('calendar.schedule', { title: 'Standup', when: '2025-01-01T09:00:00Z', durationMinutes: 30 });
      },
    );
    assert.equal(output.output.eventId, 'evt_live_9');
    assert.equal(srv.requests.length, 1);
    assert.match(srv.requests[0].body, /Standup/);
  } finally {
    await srv.close();
  }
});

test('image.generate fetches real bytes from a local HTTP provider', async () => {
  const srv = await startServer((_req, res) => json(res, 200, { b64_json: Buffer.from('PNGDATA').toString('base64'), model: 'local-image' }));
  try {
    const provider = createImageProvider({ IMAGE_PROVIDER: 'http', IMAGE_HTTP_URL: `${srv.url}/images` });
    assert.ok(provider, 'http image provider must resolve when IMAGE_HTTP_URL is set');
    const result = await provider.generate({ prompt: 'a cat', size: '512x512' });
    assert.equal(result.provider, 'http');
    assert.equal(Buffer.from(result.base64, 'base64').toString(), 'PNGDATA');
    assert.equal(srv.requests.length, 1);
  } finally {
    await srv.close();
  }
});

test('a real provider HTTP error is surfaced and never becomes a fake success', async () => {
  const srv = await startServer((_req, res) => json(res, 500, { error: { message: 'upstream exploded whsec_live_value' } }));
  try {
    await withEnv(
      { EMAIL_PROVIDER: 'webhook', EMAIL_WEBHOOK_URL: `${srv.url}/send`, EMAIL_WEBHOOK_SECRET: 'whsec_live_value' },
      async () => {
        const registry = createLiveToolRegistry();
        await assert.rejects(
          () => registry.run('email.send', { to: 'user@example.test', subject: 'Hi', body: 'Hello' }),
          (error) => {
            assert.match(error.message, /CONNECTOR_HTTP_500/);
            // The provider echoed the shared secret; it must be scrubbed.
            assert.doesNotMatch(error.message, /whsec_live_value/);
            return true;
          },
        );
      },
    );
  } finally {
    await srv.close();
  }
});

test('a transport failure is honest (CONNECTOR_UNREACHABLE), never a fake success', async () => {
  // Bind then immediately release a port so the connector talks to nothing.
  const probe = await startServer((_req, res) => json(res, 200, {}));
  const deadPort = new URL(probe.url).port;
  await probe.close();
  await withEnv(
    { EMAIL_PROVIDER: 'webhook', EMAIL_WEBHOOK_URL: `http://127.0.0.1:${deadPort}/send` },
    async () => {
      const registry = createLiveToolRegistry();
      await assert.rejects(
        () => registry.run('email.send', { to: 'user@example.test', subject: 'Hi', body: 'Hello' }),
        (error) => {
          assert.match(error.message, /CONNECTOR_UNREACHABLE/);
          // The webhook URL (which may carry a credential in its path) must not leak.
          assert.doesNotMatch(error.message, /127\.0\.0\.1/);
          return true;
        },
      );
    },
  );
});

test('connectors stay fail-closed with no credentials (no fake success)', async () => {
  await withEnv(
    {
      IMAGE_PROVIDER: undefined, IMAGE_API_KEY: undefined, IMAGE_HTTP_URL: undefined,
      OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined,
      CALENDAR_PROVIDER: undefined, CALENDAR_WEBHOOK_URL: undefined, CALENDAR_ACCESS_TOKEN: undefined,
      EMAIL_PROVIDER: undefined, EMAIL_WEBHOOK_URL: undefined, EMAIL_API_KEY: undefined,
      SLACK_WEBHOOK_URL: undefined, SLACK_BOT_TOKEN: undefined, TEAMS_WEBHOOK_URL: undefined,
      DISCORD_WEBHOOK_URL: undefined, NOTION_API_KEY: undefined, NOTION_DATABASE_ID: undefined, NOTION_PAGE_ID: undefined,
      GENERIC_WEBHOOK_URL: undefined,
      STT_PROVIDER: undefined, STT_API_KEY: undefined, STT_HTTP_URL: undefined,
      TTS_PROVIDER: undefined, TTS_API_KEY: undefined, TTS_HTTP_URL: undefined, ELEVENLABS_API_KEY: undefined,
      VIDEO_PROVIDER: undefined, VIDEO_HTTP_URL: undefined, VIDEO_API_KEY: undefined, VIDEO_API_BASE: undefined, VIDEO_MODEL: undefined,
      VIDEO_EDIT_PROVIDER: undefined, VIDEO_EDIT_HTTP_URL: undefined, REPLICATE_API_TOKEN: undefined, REPLICATE_VIDEO_VERSION: undefined, REPLICATE_VIDEO_EDIT_VERSION: undefined,
      AUDIO_PROVIDER: undefined, AUDIO_HTTP_URL: undefined,
      MEDIA_ANALYZE_HTTP_URL: undefined,
    },
    async () => {
      assert.deepEqual(connectorStatus(process.env), { image: false, vision: false, calendar: false, email: false, slack: false, teams: false, discord: false, notion: false, webhook: false, stt: false, tts: false, video: false, videoEdit: false, audio: false, mediaAnalysis: false });
      assert.equal(createImageProvider(process.env), null);
      assert.equal(createCalendarProvider(process.env), null);
      assert.equal(createEmailSendProvider(process.env), null);
      assert.equal(createSlackProvider(process.env), null);
      assert.equal(createTeamsProvider(process.env), null);
      assert.equal(createDiscordProvider(process.env), null);
      assert.equal(createNotionProvider(process.env), null);
      assert.equal(createWebhookProvider(process.env), null);

      const registry = createLiveToolRegistry();
      for (const toolId of ['image.generate', 'calendar.schedule', 'email.send', 'slack.post', 'teams.post', 'discord.post', 'notion.page.create', 'webhook.post']) {
        assert.equal(registry.status().tools.find((t) => t.id === toolId).state, 'unwired');
        await assert.rejects(
          () => registry.run(toolId, { to: 'a@b.test', subject: 's', body: 'b', title: 't', when: '2025-01-01T00:00:00Z', prompt: 'p' }),
          new RegExp(`TOOL_CONNECTOR_NOT_CONFIGURED:${toolId.replace('.', '\\.')}`),
        );
      }
    },
  );
});
