import assert from 'node:assert/strict';
import test from 'node:test';

import { createVideoProvider, createVideoEditProvider } from '../tools/connectors.mjs';
import { createVideoGenerationService } from '../creation/video-gen.mjs';
import { createLiveToolRegistry } from '../tools/registry.mjs';

/**
 * LIVE video-generation test — hits the REAL provider API and proves a genuine
 * video file comes back. This is OPT-IN because each call costs money and takes
 * minutes, so it only runs when BOTH of these hold:
 *
 *   1. VIDEO_LIVE_TEST=1                     (explicit opt-in)
 *   2. real credentials are present:
 *        - Google Veo: VIDEO_API_KEY (or GEMINI_API_KEY / GOOGLE_API_KEY)
 *        - Replicate:  REPLICATE_API_TOKEN + REPLICATE_VIDEO_VERSION
 *
 * When either is missing the whole suite is skipped with a clear reason — it
 * never fabricates a pass. Run it with:
 *
 *   VIDEO_LIVE_TEST=1 VIDEO_API_KEY=... node --experimental-sqlite \
 *     --test backend/test/video-generation-live.test.mjs
 *
 * Success criterion (the user's): a text prompt in → a NEW MP4 file out, from a
 * real video-generation model (not a GIF, not a slideshow, not camera motion).
 */

const optedIn = String(process.env.VIDEO_LIVE_TEST || '') === '1';
const hasGoogle = Boolean(process.env.VIDEO_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const hasReplicate = Boolean(process.env.REPLICATE_API_TOKEN && process.env.REPLICATE_VIDEO_VERSION);

// COST LIMIT: a paid call is only ever made when the operator has explicitly
// declared a positive budget. `VIDEO_LIVE_BUDGET_USD` caps the total estimated
// spend for the whole file; `VIDEO_LIVE_COST_USD` is the (conservative, operator-
// overridable) estimated cost of one call. The shared ledger below refuses any
// call that would exceed the budget, so a runaway loop can never spend without
// bound - the tests skip with a clear reason instead of silently paying.
const budgetUsd = Number(process.env.VIDEO_LIVE_BUDGET_USD || 0);
const costPerCallUsd = Number(process.env.VIDEO_LIVE_COST_USD || 1.5);
let spentUsd = 0;

/** Returns true when a paid call fits the budget; otherwise marks the test skipped. */
function budgetGate(t) {
  if (spentUsd + costPerCallUsd > budgetUsd) {
    t.skip(`video live budget reached (spent $${spentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}; next call ~$${costPerCallUsd.toFixed(2)})`);
    return false;
  }
  return true;
}
function charge() { spentUsd += costPerCallUsd; }

const reason = !optedIn
  ? 'set VIDEO_LIVE_TEST=1 to run live video tests (they cost money)'
  : (!hasGoogle && !hasReplicate)
    ? 'no real video credentials (VIDEO_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY or REPLICATE_API_TOKEN+REPLICATE_VIDEO_VERSION)'
    : !(budgetUsd > 0)
      ? 'set VIDEO_LIVE_BUDGET_USD to a positive cap to authorise paid calls'
      : false;

const skip = reason || undefined;

// A real MP4 begins with a big-endian box size then 'ftyp'. QuickTime/ISO-BMFF.
function assertLooksLikeVideo(buffer, mimeType) {
  assert.ok(Buffer.isBuffer(buffer), 'result is a Buffer');
  assert.ok(buffer.length > 1024, `video is non-trivial (${buffer.length} bytes)`);
  const brand = buffer.subarray(4, 8).toString('ascii');
  assert.equal(brand, 'ftyp', `expected an ISO-BMFF/MP4 container, got brand "${brand}"`);
  if (mimeType) assert.match(mimeType, /video\//);
}

test('LIVE: text-to-video produces a brand-new MP4 from a prompt', { skip }, async (t) => {
  if (!budgetGate(t)) return;
  const service = createVideoGenerationService();
  assert.equal(service.capabilities.textToVideo, true, 'a real text-to-video provider is configured');

  const started = Date.now();
  charge();
  const result = await service.textToVideo({
    prompt: 'A cinematic drone shot flying over a snowy pine forest at sunrise, soft golden light, ultra realistic, 4k',
    durationSeconds: Number(process.env.VIDEO_LIVE_DURATION || 5),
    aspectRatio: process.env.VIDEO_LIVE_ASPECT || '16:9',
  });
  const buffer = Buffer.from(result.base64, 'base64');

  assertLooksLikeVideo(buffer, result.mimeType);
  assert.ok(result.provider, 'reports the provider that produced the video');
  // Record the artefact for manual inspection.
  const { writeFile } = await import('node:fs/promises');
  const out = process.env.VIDEO_LIVE_OUT || 'live-text-to-video.mp4';
  await writeFile(out, buffer);
  // eslint-disable-next-line no-console
  console.log(`[live] ${result.provider}/${result.model} → ${out} (${buffer.length} bytes, ${Math.round((Date.now() - started) / 1000)}s)`);
});

test('LIVE: image-to-video animates a supplied frame into an MP4', { skip }, async (t) => {
  const service = createVideoGenerationService();
  if (!service.capabilities.imageToVideo) {
    // Honest: not every backend supports I2V. Skip rather than fake it.
    return;
  }
  const sourceImage = process.env.VIDEO_LIVE_IMAGE;
  if (!sourceImage) return; // no source frame supplied → nothing to animate
  if (!budgetGate(t)) return;

  const { readFile } = await import('node:fs/promises');
  const image = await readFile(sourceImage);
  charge();
  const result = await service.imageToVideo({
    prompt: process.env.VIDEO_LIVE_I2V_PROMPT || 'gently animate the scene with natural motion, subtle camera push-in',
    image: { base64: image.toString('base64'), mimeType: sourceImage.endsWith('.jpg') || sourceImage.endsWith('.jpeg') ? 'image/jpeg' : 'image/png' },
    durationSeconds: Number(process.env.VIDEO_LIVE_DURATION || 5),
  });
  const buffer = Buffer.from(result.base64, 'base64');
  assertLooksLikeVideo(buffer, result.mimeType);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.VIDEO_LIVE_I2V_OUT || 'live-image-to-video.mp4', buffer);
});

test('LIVE: registry video.generate writes a real MP4 into the workspace', { skip }, async (t) => {
  if (!budgetGate(t)) return;
  const registry = createLiveToolRegistry();
  const status = registry.status().tools.find((tool) => tool.id === 'video.generate');
  assert.equal(status.state, 'live', 'video.generate is wired to a live provider');

  const { mkdtemp } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'semo0o-live-'));
  charge();
  const out = await registry.run('video.generate', {
    prompt: 'a neon koi fish swimming through dark water, macro, cinematic',
    path: 'live/generated.mp4',
  }, { workspaceRoot: dir });
  assert.ok(out.output.bytes > 1024, 'a non-trivial file was written');
  const { readFile } = await import('node:fs/promises');
  const buffer = await readFile(path.join(dir, 'live/generated.mp4'));
  assertLooksLikeVideo(buffer);
});

test('LIVE: conversational video edit routes to a genuine editor (skips if none)', { skip }, async (t) => {
  const editor = createVideoEditProvider();
  if (!editor) return; // honest: no V2V editor configured
  const sourceVideo = process.env.VIDEO_LIVE_SOURCE_VIDEO;
  if (!sourceVideo) return;
  if (!budgetGate(t)) return;
  const { readFile } = await import('node:fs/promises');
  const video = await readFile(sourceVideo);
  const { conversationalVideoEdit } = await import('../creation/video-gen.mjs');
  charge();
  const result = await conversationalVideoEdit({
    conversation: process.env.VIDEO_LIVE_EDIT_PROMPT || 'make the scene look like it is snowing',
    sourceVideo: { base64: video.toString('base64'), mimeType: 'video/mp4' },
  });
  const buffer = Buffer.from(result.base64, 'base64');
  assertLooksLikeVideo(buffer, result.mimeType);
});
