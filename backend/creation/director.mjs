// Director — the autonomous creation loop.
//
// This is the "brain" that turns ONE goal into a finished video:
//
//   goal → brief → storyboard → bibles → produce assets → compose timeline
//        → render → critique → (revise) → render → … → deliver bundle
//
// It is budget-bounded (iterations, provider calls, wall-clock), emits events
// for live progress, keeps the best-scoring iteration, and degrades gracefully:
// with no model providers at all it still produces a real video via the Local
// Studio.

import { buildBrief } from './brief.mjs';
import { buildStoryboard, normalizeStoryboard } from './storyboard.mjs';
import { buildBiblesAsync } from './bibles.mjs';
import { compileStoryboardPrompts } from './promptsmith.mjs';
import { composeTimeline } from './local-studio.mjs';
import { renderTimeline, framesToGif, framesToAvi, framesToPngSequence } from '../media/render.mjs';
import { critique } from './critic.mjs';
import { buildBundle } from './bundle.mjs';
import { createLocalOnlyProviders } from './providers.mjs';

const DEFAULT_BUDGET = {
  maxIterations: 2,
  maxProviderCalls: 8,
  maxDurationMs: 10 * 60 * 1000,
  threshold: 0.82,
};

// Render-resolution presets cap the longest side so the dependency-free Local
// Studio stays fast and its artefacts stay a sensible size. `full` keeps the
// brief's requested resolution.
const RESOLUTION_PRESETS = { draft: 480, standard: 720, high: 960, full: Infinity };

function resolveResolution(brief, options) {
  const preset = options.resolution || 'standard';
  const cap = options.maxDimension || RESOLUTION_PRESETS[preset] || 720;
  const longest = Math.max(brief.width, brief.height);
  if (!Number.isFinite(cap) || longest <= cap) return { width: brief.width, height: brief.height, scale: 1 };
  const scale = cap / longest;
  const even = (n) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(brief.width), height: even(brief.height), scale };
}

function clampDuration(scenes) {
  return scenes.map((s) => ({ ...s, duration: Math.max(2, Math.min(6, s.duration)) }));
}

// The brief-affecting options a caller may pass. Forwarded to buildBrief so an
// explicit format/duration/palette/fps always overrides the model's guess.
function briefOptions(options = {}) {
  return {
    llm: options.llm,
    model: options.model,
    signal: options.signal,
    format: options.format,
    duration: options.duration,
    palette: options.palette,
    fps: options.fps,
    audience: options.audience,
    musicMood: options.musicMood,
    cta: options.cta,
    captions: options.captions,
    voiceover: options.voiceover,
  };
}

function applyRevisions({ brief, storyboard, critiqueResult, iteration }) {
  const directives = critiqueResult.directives || [];
  const areas = new Set(directives.map((d) => d.area));
  let nextBrief = { ...brief };
  let nextStoryboard = { scenes: storyboard.scenes.map((s) => ({ ...s })) };
  const changes = [];

  if (areas.has('pacing')) {
    nextStoryboard.scenes = clampDuration(nextStoryboard.scenes);
    changes.push('rebalanced scene durations to 2–6s');
  }
  if (areas.has('motion')) {
    const cycle = ['kenburns', 'zoomIn', 'panRight', 'zoomOut'];
    nextStoryboard.scenes = nextStoryboard.scenes.map((s, i) => ({
      ...s,
      camera: s.camera === 'static' ? cycle[i % cycle.length] : s.camera,
    }));
    changes.push('added camera movement');
  }
  if (areas.has('legibility')) {
    nextBrief = { ...nextBrief, __boostContrast: true };
    changes.push('boosted title contrast and size');
  }
  if (areas.has('audio') && !nextBrief.musicMood) {
    nextBrief = { ...nextBrief, musicMood: brief.mood };
    changes.push('enabled music bed');
  }
  if (areas.has('coherence')) {
    const suggestions = directives.filter((d) => d.area === 'coherence').map((d) => d.detail).slice(0, 2);
    nextStoryboard.scenes = nextStoryboard.scenes.map((s, i) => (
      i < suggestions.length ? { ...s, subhead: String(suggestions[i]).slice(0, 90) } : s
    ));
    changes.push('refined narrative copy');
  }
  return { brief: nextBrief, storyboard: nextStoryboard, changes };
}

async function produceAssets({ brief, storyboard, bibles, providers, options, budget }) {
  const assets = new Map();
  if (!providers.image || options.useImages === false) return assets;
  const prompts = compileStoryboardPrompts(storyboard, bibles, brief);
  let calls = 0;
  for (const p of prompts) {
    if (options.signal?.aborted) break;
    if (calls >= budget.maxProviderCalls) {
      options.onEvent?.('budget', { reason: 'maxProviderCalls', calls });
      break;
    }
    try {
      calls++;
      options.onEvent?.('asset_start', { sceneId: p.sceneId, prompt: p.image.positive.slice(0, 120) });
      const res = await providers.image.generate({
        prompt: p.image.positive,
        size: `${brief.width}x${brief.height}`,
        negativePrompt: p.image.negative,
      });
      if (res.canvas) assets.set(p.sceneId, res.canvas);
      options.onEvent?.('asset_done', { sceneId: p.sceneId, provider: res.provider, model: res.model, ok: !!res.canvas });
    } catch (error) {
      options.onEvent?.('asset_error', { sceneId: p.sceneId, error: String(error?.message || error) });
    }
  }
  return assets;
}

/**
 * Run the full autonomous creation pipeline.
 * @param {string|object} goal
 * @param {object} options
 * @param {object} [options.llm]
 * @param {string} [options.model]
 * @param {object} [options.providers]
 * @param {(type:string,payload:object)=>void} [options.onEvent]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>}
 */
export async function runDirector(goal, options = {}) {
  const started = Date.now();
  const budget = { ...DEFAULT_BUDGET, ...(options.budget || {}) };
  const providers = options.providers || createLocalOnlyProviders();
  const emit = (type, payload = {}) => {
    try { options.onEvent?.(type, payload); } catch { /* never let a listener break the run */ }
  };
  const guard = () => {
    if (options.signal?.aborted) throw new Error('CREATION_CANCELLED');
    if (Date.now() - started > budget.maxDurationMs) throw new Error('CREATION_TIME_LIMIT');
  };

  // 1. Brief
  emit('stage', { stage: 'brief' });
  const requested = await buildBrief(goal, { llm: options.llm, model: options.model, signal: options.signal });
  const res = resolveResolution(requested, options);
  const brief = {
    ...requested,
    width: res.width,
    height: res.height,
    requestedWidth: requested.width,
    requestedHeight: requested.height,
    renderScale: res.scale,
  };
  emit('brief', { brief });

  // 2. Storyboard
  guard();
  emit('stage', { stage: 'storyboard' });
  let storyboard = await buildStoryboard(brief, { llm: options.llm, model: options.model, signal: options.signal });
  emit('storyboard', { storyboard });

  // 3. Bibles
  guard();
  emit('stage', { stage: 'bibles' });
  const bibles = await buildBiblesAsync(brief, { llm: options.llm, model: options.model, signal: options.signal });
  emit('bibles', { bibles });

  // 4. Produce assets (provider images, when available)
  guard();
  emit('stage', { stage: 'produce' });
  const assets = await produceAssets({ brief, storyboard, bibles, providers, options, budget });

  // 5–8. Compose → render → critique → revise loop
  let best = null;
  let currentBrief = brief;
  let currentStoryboard = storyboard;
  const iterations = [];

  for (let i = 0; i < budget.maxIterations; i++) {
    guard();
    emit('stage', { stage: 'compose', iteration: i });
    const timeline = composeTimeline({ brief: currentBrief, storyboard: currentStoryboard, bibles, assets });
    if (currentBrief.__boostContrast) {
      for (const scene of timeline.scenes) {
        for (const layer of scene.layers) {
          if (layer.type === 'text') { layer.scale = Math.round(layer.scale * 1.25); layer.shadow = { color: 'rgba(0,0,0,0.75)', dx: 2, dy: 2 }; }
        }
      }
    }
    emit('stage', { stage: 'render', iteration: i });
    const rendered = renderTimeline(timeline, {
      assets,
      includeAudio: true,
      fps: options.fps || Math.min(brief.fps, 24),
      onProgress: (done, total) => emit('render_progress', { iteration: i, done, total }),
    });
    emit('stage', { stage: 'critique', iteration: i });
    const critiqueResult = await critique(
      { frames: rendered.frames, audio: rendered.audio, timeline: rendered.timeline, brief: currentBrief, storyboard: currentStoryboard },
      { llm: options.llm, model: options.model, signal: options.signal },
    );
    const record = { iteration: i, score: critiqueResult.score, critique: critiqueResult };
    iterations.push(record);
    emit('critique', { iteration: i, score: critiqueResult.score, subscores: critiqueResult.subscores, issues: critiqueResult.issues });

    if (!best || critiqueResult.score > best.score) {
      best = { score: critiqueResult.score, rendered, timeline: rendered.timeline, critique: critiqueResult, brief: currentBrief, storyboard: currentStoryboard };
    }
    if (critiqueResult.score >= budget.threshold || i === budget.maxIterations - 1) break;

    const revised = applyRevisions({ brief: currentBrief, storyboard: currentStoryboard, critiqueResult, iteration: i });
    if (revised.changes.length === 0) break;
    emit('revision', { iteration: i, changes: revised.changes });
    currentBrief = revised.brief;
    currentStoryboard = normalizeStoryboard(revised.storyboard, revised.brief);
  }

  // 9. Encode final artefacts from the best iteration
  guard();
  emit('stage', { stage: 'encode' });
  const { frames, audio, width, height, fps, duration, timeline } = best.rendered;
  const media = { audio };
  if (options.formats !== false) {
    // GIF is a lightweight preview: cap its size and frame rate independently.
    const gifMaxDim = options.gifMaxDimension || 480;
    const gifScale = Math.min(1, gifMaxDim / Math.max(width, height));
    media.gif = framesToGif(frames, {
      width, height, fps,
      dither: options.dither,
      scale: gifScale,
      gifFps: options.gifFps || Math.min(fps, 12),
    });
    media.avi = framesToAvi(frames, audio, { width, height, fps, quality: options.quality || 82 });
    if (options.pngSequence) media.pngs = framesToPngSequence(frames);
  }

  const manifest = {
    title: best.brief.title,
    goal: best.brief.goal,
    width,
    height,
    requestedWidth: best.brief.requestedWidth || width,
    requestedHeight: best.brief.requestedHeight || height,
    renderScale: best.brief.renderScale || 1,
    fps,
    duration,
    frameCount: frames.length,
    hasAudio: !!audio,
    formats: [media.gif && 'gif', media.avi && 'avi', media.pngs && 'png'].filter(Boolean),
    score: best.score,
    iterations: iterations.length,
    providers: providers.capabilities,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  };

  let bundle = null;
  if (options.bundle !== false) {
    emit('stage', { stage: 'bundle' });
    bundle = await buildBundle({
      brief: best.brief,
      storyboard: best.storyboard,
      bibles,
      timeline,
      critique: best.critique,
      manifest,
      media,
    });
  }

  emit('deliver', { manifest });
  return {
    status: 'completed',
    brief: best.brief,
    storyboard: best.storyboard,
    bibles,
    timeline,
    critique: best.critique,
    iterations,
    manifest,
    media: { ...media, bundle },
    assets: [...assets.keys()],
    elapsedMs: Date.now() - started,
  };
}

/**
 * Plan a creation from ONE goal WITHOUT rendering: brief → storyboard → bibles
 * → provider-ready shot prompts. This is the fast "think" half of the Director,
 * useful for previews, review gates and for driving external renderers.
 * @param {string|object} goal
 * @param {object} [options]
 * @returns {Promise<{brief:object, storyboard:object, bibles:object, prompts:Array, elapsedMs:number}>}
 */
export async function planCreation(goal, options = {}) {
  const started = Date.now();
  const requested = await buildBrief(goal, briefOptions(options));
  const res = resolveResolution(requested, options);
  const brief = {
    ...requested,
    width: res.width,
    height: res.height,
    requestedWidth: requested.width,
    requestedHeight: requested.height,
    renderScale: res.scale,
  };
  const storyboard = await buildStoryboard(brief, { llm: options.llm, model: options.model, signal: options.signal });
  const bibles = await buildBiblesAsync(brief, { llm: options.llm, model: options.model, signal: options.signal });
  const prompts = compileStoryboardPrompts(storyboard, bibles, brief);
  return { brief, storyboard, bibles, prompts, elapsedMs: Date.now() - started };
}
