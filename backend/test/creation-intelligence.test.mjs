import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBrief, buildBriefDeterministic, validateBrief, PALETTES, FORMATS,
  buildStoryboard, buildStoryboardDeterministic, normalizeStoryboard, validateStoryboard,
  buildStyleBible, buildCharacterBibleDeterministic, buildBibles, buildBiblesAsync,
  compileShotPrompts, compileVideoPrompt, compileStoryboardPrompts, compileNegativePrompt,
  composeTimeline, critique, critiqueDeterministic,
  createCreationProviders, createLocalOnlyProviders, decodeImageBytes,
  runDirector, planCreation,
} from '../creation/index.mjs';
import { parseGif } from '../media/gif.mjs';
import { parseAvi } from '../media/avi.mjs';
import { validateTimeline, timelineDuration } from '../media/timeline.mjs';
import { createCanvas, fillRect } from '../media/raster.mjs';
import { encodePng } from '../media/png.mjs';

/* ------------------------------------------------------------------ */
/* Brief                                                               */
/* ------------------------------------------------------------------ */

test('brief: deterministic interpreter classifies type/format/palette', () => {
  const launch = buildBriefDeterministic({ goal: 'Launch video for our new AI note-taking app' });
  assert.equal(launch.type, 'launch');
  assert.ok(launch.duration > 0 && launch.duration <= 300);
  assert.ok(launch.title.length > 0 && launch.title.length <= 60);
  assert.ok(launch.width > 0 && launch.height > 0);
  assert.equal(validateBrief(launch).ok, true);

  const portrait = buildBriefDeterministic({ goal: 'Instagram story about morning coffee', format: 'portrait' });
  assert.equal(portrait.format, 'portrait');
  assert.equal(portrait.height, FORMATS.portrait.height);

  const arabic = buildBriefDeterministic({ goal: 'فيديو تعريفي عن تطبيق جديد لإدارة المهام' });
  assert.equal(arabic.language, 'ar');
  assert.ok(arabic.title.length > 0);
});

test('brief: clamps out-of-range duration/fps and rejects unknown enums', () => {
  const brief = buildBriefDeterministic({ goal: 'promo', duration: 9999, fps: 120, format: 'nope', palette: 'nope' });
  assert.ok(brief.duration <= 300 && brief.duration >= 4);
  assert.ok(brief.fps <= 30 && brief.fps >= 6);
  assert.equal(brief.format, 'landscape');
  assert.ok(PALETTES[brief.palette]);
});

test('brief: LLM path falls back to deterministic when no model is present', async () => {
  const brief = await buildBrief('Explainer about quantum computing for kids', { llm: null });
  assert.equal(brief.source, 'deterministic');
  assert.equal(validateBrief(brief).ok, true);
});

/* ------------------------------------------------------------------ */
/* Storyboard                                                          */
/* ------------------------------------------------------------------ */

test('storyboard: deterministic beats produce a valid, ordered board', () => {
  const brief = buildBriefDeterministic({ goal: 'Launch video for a smart water bottle', duration: 24 });
  const board = buildStoryboardDeterministic(brief);
  assert.ok(board.scenes.length >= 3 && board.scenes.length <= 9);
  assert.equal(board.scenes[0].transitionIn, 'none');
  assert.equal(validateStoryboard(board).ok, true);
  const total = board.scenes.reduce((s, x) => s + x.duration, 0);
  assert.ok(Math.abs(total - brief.duration) < brief.duration * 0.5 + 2);
  for (const scene of board.scenes) assert.ok(scene.headline.length <= 42);
});

test('storyboard: normalize repairs hostile input', () => {
  const brief = buildBriefDeterministic({ goal: 'story' });
  const repaired = normalizeStoryboard({ scenes: [{ headline: 'x'.repeat(200), duration: -5, camera: 'bogus' }] }, brief);
  assert.equal(repaired.scenes[0].camera, 'static');
  assert.ok(repaired.scenes[0].duration >= 1.5);
  assert.ok(repaired.scenes[0].headline.length <= 42);
  assert.equal(validateStoryboard(repaired).ok, true);
});

test('storyboard: LLM path degrades to deterministic without a model', async () => {
  const brief = buildBriefDeterministic({ goal: 'tutorial on git' });
  const board = await buildStoryboard(brief, { llm: null });
  assert.equal(board.source, 'deterministic');
  assert.equal(validateStoryboard(board).ok, true);
});

/* ------------------------------------------------------------------ */
/* Bibles                                                              */
/* ------------------------------------------------------------------ */

test('bibles: style bible pins palette, motion and a negative prompt', () => {
  const brief = buildBriefDeterministic({ goal: 'cinematic launch', palette: 'midnight' });
  const bibles = buildBibles(brief);
  assert.equal(bibles.style.palette.accent, PALETTES.midnight.accent);
  assert.ok(bibles.style.negativePrompt.includes('watermark'));
  assert.ok(bibles.style.motion.energy >= 0 && bibles.style.motion.energy <= 1);
  assert.ok(Array.isArray(bibles.characters.characters));
});

test('bibles: async builder is deterministic without a model', async () => {
  const brief = buildBriefDeterministic({ goal: 'promo for a bakery' });
  const bibles = await buildBiblesAsync(brief, { llm: null });
  assert.equal(bibles.characters.source, 'deterministic');
  assert.equal(bibles.style.palette.background, brief.paletteColors.background);
});

/* ------------------------------------------------------------------ */
/* PromptSmith                                                         */
/* ------------------------------------------------------------------ */

test('promptsmith: prompts carry style, camera, lighting and negative tokens', () => {
  const brief = buildBriefDeterministic({ goal: 'energetic product promo', mood: 'energetic' });
  const board = buildStoryboardDeterministic(brief);
  const bibles = buildBibles(brief);
  const prompts = compileStoryboardPrompts(board, bibles, brief);
  assert.equal(prompts.length, board.scenes.length);
  const first = prompts[0];
  assert.ok(first.image.positive.includes(bibles.style.styleTokens));
  assert.ok(first.image.negative.includes('watermark'));
  assert.equal(first.image.aspect, brief.format);
  assert.ok(first.video.positive.length >= first.image.positive.length);
  assert.equal(first.video.durationSeconds, board.scenes[0].duration);
  assert.ok(compileNegativePrompt(bibles).length > 0);
  // Camera phrase must appear for a moving shot.
  const moving = board.scenes.find((s) => s.camera !== 'static');
  if (moving) {
    const shot = compileShotPrompts(moving, bibles, brief);
    assert.ok(shot.positive.toLowerCase().includes('camera') || shot.positive.toLowerCase().includes('pan') || shot.positive.toLowerCase().includes('tilt') || shot.positive.toLowerCase().includes('zoom') || shot.positive.toLowerCase().includes('push'));
  }
});

/* ------------------------------------------------------------------ */
/* Local Studio + Critic                                               */
/* ------------------------------------------------------------------ */

test('local-studio: composes a valid timeline from brief + storyboard', () => {
  const brief = buildBriefDeterministic({ goal: 'launch video', duration: 12 });
  const board = buildStoryboardDeterministic(brief);
  const bibles = buildBibles(brief);
  const timeline = composeTimeline({ brief, storyboard: board, bibles, assets: {} });
  assert.equal(validateTimeline(timeline).ok, true);
  assert.ok(timeline.scenes.length === board.scenes.length);
  assert.ok(timelineDuration(timeline) > 0);
  assert.ok(timeline.audio && timeline.audio.mood);
});

test('critic: deterministic scoring is bounded and emits directives', () => {
  const brief = buildBriefDeterministic({ goal: 'launch video', duration: 12 });
  const board = buildStoryboardDeterministic(brief);
  const bibles = buildBibles(brief);
  const timeline = composeTimeline({ brief, storyboard: board, bibles, assets: {} });
  // Two synthetic frames with visible difference + a tiny audio buffer.
  const f0 = createCanvas(64, 36, { background: '#000000' });
  const f1 = createCanvas(64, 36, { background: '#000000' });
  fillRect(f1, 0, 0, 64, 36, '#ffffff');
  const audio = { sampleRate: 22050, channels: 2, data: new Float32Array(22050 * 2) };
  const result = critiqueDeterministic({ frames: [f0, f1], audio, timeline, brief, storyboard: board });
  assert.ok(result.score >= 0 && result.score <= 1);
  assert.ok(result.subscores.motion >= 0 && result.subscores.motion <= 1);
  assert.ok(Array.isArray(result.directives));
});

test('critic: async critique without a model is deterministic-only', async () => {
  const brief = buildBriefDeterministic({ goal: 'launch video' });
  const board = buildStoryboardDeterministic(brief);
  const timeline = composeTimeline({ brief, storyboard: board, bibles: buildBibles(brief), assets: {} });
  const result = await critique({ frames: [], audio: null, timeline, brief, storyboard: board }, { llm: null });
  assert.equal(result.source, 'deterministic');
  assert.ok(result.score >= 0 && result.score <= 1);
});

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

test('providers: local-only set reports honest capabilities', () => {
  const providers = createLocalOnlyProviders();
  assert.deepEqual(providers.capabilities, { image: false, vision: false, tts: false, video: false, music: false, mediaAnalysis: false });
  const status = providers.status();
  assert.equal(status.localStudio, true);
});

test('providers: createCreationProviders fails closed with no env', () => {
  const providers = createCreationProviders({});
  assert.equal(providers.capabilities.image, false);
  assert.equal(providers.capabilities.video, false);
  assert.equal(providers.image, null);
});

test('providers: decodeImageBytes decodes a PNG we produced', () => {
  const canvas = createCanvas(8, 4, { background: '#123456' });
  fillRect(canvas, 0, 0, 4, 4, '#ffffff');
  const png = encodePng({ width: 8, height: 4, data: canvas.data });
  const decoded = decodeImageBytes(png, 'image/png');
  assert.equal(decoded.width, 8);
  assert.equal(decoded.height, 4);
});

/* ------------------------------------------------------------------ */
/* Director (end-to-end, draft resolution)                             */
/* ------------------------------------------------------------------ */

test('director: one goal produces a real GIF + AVI + bundle (draft)', async () => {
  const events = [];
  const result = await runDirector('Launch video for our new AI note-taking app', {
    resolution: 'draft',
    fps: 12,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  assert.equal(result.status, 'completed');
  assert.ok(result.brief && result.storyboard && result.bibles && result.timeline);
  assert.ok(result.iterations.length >= 1);
  assert.ok(result.iterations[0].score > 0 && result.iterations[0].score <= 1);
  assert.ok(result.media.gif && result.media.gif.length > 0);
  assert.ok(result.media.avi && result.media.avi.length > 0);
  assert.ok(result.media.bundle && result.media.bundle.length > 0);

  const gif = parseGif(result.media.gif);
  assert.ok(gif.width > 0 && gif.height > 0);
  assert.ok(gif.frames > 1);

  const avi = parseAvi(result.media.avi);
  assert.ok(avi.width > 0 && avi.height > 0);
  assert.ok(avi.totalFrames > 1);

  assert.ok(result.manifest.frameCount > 0);
  assert.ok(events.some((e) => e.type === 'stage'));
  assert.ok(events.some((e) => e.type === 'job.completed' || e.type === 'deliver'));
});

test('director: planCreation returns a plan without rendering', async () => {
  const plan = await planCreation('Tutorial: how to brew pour-over coffee', { resolution: 'draft' });
  assert.ok(plan.brief && plan.storyboard && plan.bibles && plan.prompts);
  assert.equal(plan.prompts.length, plan.storyboard.scenes.length);
  assert.ok(typeof plan.elapsedMs === 'number');
});

test('director: runDirector honors explicit brief overrides (format/duration/palette/cta)', async () => {
  // Regression: the full pipeline used to drop caller overrides (only planCreation
  // forwarded them), so an explicit format/duration was silently ignored.
  const result = await runDirector('Launch video for a smart water bottle', {
    resolution: 'draft',
    format: 'portrait',
    duration: 12,
    palette: 'neon',
    cta: 'Preorder now',
    captions: false,
    bundle: false,
    formats: false,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.brief.format, 'portrait');
  assert.equal(result.brief.requestedWidth, 720);
  assert.equal(result.brief.requestedHeight, 1280);
  assert.equal(result.brief.duration, 12);
  assert.equal(result.brief.palette, 'neon');
  assert.equal(result.brief.cta, 'Preorder now');
  assert.equal(result.brief.captions, false);
});

test('director: cancellation aborts the run honestly', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runDirector('promo', { resolution: 'draft', signal: controller.signal }),
    /CREATION_CANCELLED/,
  );
});
