// Deterministic Renderer — Timeline → frames → real media files.
//
// The renderer walks a normalised Timeline frame by frame, compositing scene
// backgrounds, camera moves, layer animations and scene transitions on the RGBA
// raster, then encodes the result to animated GIF, MJPEG/AVI (with a procedural
// music bed) and/or a PNG sequence. Given the same Timeline it always produces
// identical bytes, which is what makes the whole creation pipeline reproducible.

import {
  createCanvas,
  cloneCanvas,
  fillRect,
  fillRoundedRect,
  fillCircle,
  fillPolygon,
  drawLine,
  drawText,
  drawCaption,
  linearGradient,
  radialGradient,
  blit,
  extractViewport,
  vignette,
  addNoise,
  tint,
  crossfade,
  applyTransition,
  resizeCanvas,
} from './raster.mjs';
import { createRng } from './random.mjs';
import { normalizeTimeline, sceneAt, validateTimeline } from './timeline.mjs';
import { encodeGif } from './gif.mjs';
import { encodeJpeg } from './jpeg.mjs';
import { encodeAvi } from './avi.mjs';
import { encodePng } from './png.mjs';
import { composeMusic, toInt16, upmix } from './audio.mjs';

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

export function easing(name, t) {
  const p = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (name) {
    case 'linear': return p;
    case 'easeIn': return p * p;
    case 'easeOut': return 1 - (1 - p) * (1 - p);
    case 'easeInOut': return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    case 'easeOutBack': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
    }
    case 'easeOutCubic': return 1 - Math.pow(1 - p, 3);
    default: return 1 - (1 - p) * (1 - p);
  }
}

// ---------------------------------------------------------------------------
// Layer animation
// ---------------------------------------------------------------------------

export function computeAnimation(anim, local) {
  const out = { opacity: 1, dx: 0, dy: 0, scale: 1, reveal: 1 };
  if (!anim || anim.type === 'none') return out;
  const t0 = anim.delay || 0;
  const d = Math.max(0.001, anim.duration || 0.6);
  const p = Math.max(0, Math.min(1, (local - t0) / d));
  const e = easing(anim.easing, p);
  switch (anim.type) {
    case 'fadeIn': out.opacity = e; break;
    case 'slideUp': out.dy = (1 - e) * 48; out.opacity = e; break;
    case 'slideDown': out.dy = -(1 - e) * 48; out.opacity = e; break;
    case 'slideLeft': out.dx = (1 - e) * 64; out.opacity = e; break;
    case 'slideRight': out.dx = -(1 - e) * 64; out.opacity = e; break;
    case 'scaleIn': out.scale = 0.6 + 0.4 * e; out.opacity = e; break;
    case 'typewriter': out.reveal = e; break;
    case 'pulse': out.scale = 1 + 0.05 * Math.sin(local * 4); break;
    case 'float': out.dy = Math.sin(local * 2) * 6; break;
    default: break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

export function drawBackground(canvas, background, ctx) {
  const W = canvas.width;
  const H = canvas.height;
  if (!background) { fillRect(canvas, 0, 0, W, H, '#0b1020'); return; }
  if (background.type === 'gradient') {
    linearGradient(canvas, {
      from: background.from || '#1e3a8a',
      to: background.to || '#0f172a',
      x0: (background.angle === 'horizontal' ? 0 : W / 2),
      y0: (background.angle === 'horizontal' ? H / 2 : 0),
      x1: (background.angle === 'horizontal' ? W : W / 2),
      y1: (background.angle === 'horizontal' ? H / 2 : H),
      stops: background.stops || null,
    });
    return;
  }
  if (background.type === 'radial') {
    radialGradient(canvas, {
      cx: background.cx === undefined ? 0.5 : background.cx,
      cy: background.cy === undefined ? 0.5 : background.cy,
      radius: background.radius || 0.8,
      stops: background.stops || [{ at: 0, color: background.from || '#334155' }, { at: 1, color: background.to || '#0b1020' }],
    });
    return;
  }
  if (background.type === 'image') {
    const asset = ctx.assets.get(background.src);
    if (asset) { blit(canvas, asset, { x: 0, y: 0, w: W, h: H, fit: background.fit || 'cover' }); return; }
    fillRect(canvas, 0, 0, W, H, background.fallback || '#0b1020');
    return;
  }
  fillRect(canvas, 0, 0, W, H, background.color || '#0b1020');
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export function drawLayer(canvas, layer, anim, ctx) {
  const opacity = (layer.opacity === undefined ? 1 : layer.opacity) * anim.opacity;
  if (opacity <= 0.001) return;
  const W = canvas.width;
  const H = canvas.height;

  if (layer.type === 'text' || layer.type === 'caption') {
    let text = layer.text;
    if (anim.reveal < 1) {
      const chars = Math.ceil(text.length * anim.reveal);
      text = text.slice(0, chars);
    }
    const scale = layer.scale * anim.scale;
    const options = {
      x: layer.x + anim.dx,
      y: layer.y + anim.dy,
      color: layer.color,
      scale,
      align: layer.align,
      anchor: layer.anchor,
      wrap: layer.wrap,
      maxWidth: layer.maxWidth > 0 ? layer.maxWidth : (layer.wrap ? W - layer.x - 16 : Infinity),
      letterSpacing: layer.letterSpacing,
      lineSpacing: layer.lineSpacing,
      shadow: layer.shadow,
      background: layer.background,
      backgroundPadding: layer.backgroundPadding,
      backgroundRadius: layer.backgroundRadius,
      opacity,
    };
    if (layer.type === 'caption') {
      drawCaption(canvas, text, { ...options, padding: layer.padding });
    } else {
      drawText(canvas, text, options);
    }
    return;
  }

  if (layer.type === 'shape') {
    const x = layer.x + anim.dx;
    const y = layer.y + anim.dy;
    if (layer.shape === 'circle') {
      fillCircle(canvas, x, y, (layer.w / 2) * anim.scale, layer.color, opacity);
    } else if (layer.shape === 'polygon' && layer.points) {
      fillPolygon(canvas, layer.points, layer.color, opacity);
    } else if (layer.shape === 'line') {
      drawLine(canvas, x, y, x + layer.w, y + layer.h, layer.color, layer.radius || 2, opacity);
    } else if (layer.radius > 0) {
      fillRoundedRect(canvas, x, y, layer.w * anim.scale, layer.h * anim.scale, layer.radius, layer.color, opacity);
    } else {
      fillRect(canvas, x, y, layer.w * anim.scale, layer.h * anim.scale, layer.color, opacity);
    }
    return;
  }

  if (layer.type === 'image') {
    const asset = ctx.assets.get(layer.src);
    if (!asset) return;
    const w = (layer.w || W) * anim.scale;
    const h = (layer.h || H) * anim.scale;
    blit(canvas, asset, { x: layer.x + anim.dx, y: layer.y + anim.dy, w, h, fit: layer.fit, alpha: opacity });
    return;
  }

  // solid
  fillRect(canvas, layer.x + anim.dx, layer.y + anim.dy, layer.w || W, layer.h || H, layer.color, opacity);
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

export function applyCamera(canvas, camera, options, progress) {
  const W = canvas.width;
  const H = canvas.height;
  const p = Math.max(0, Math.min(1, progress));
  let vw = W;
  let vh = H;
  let vx = 0;
  let vy = 0;
  const intensity = options && options.intensity !== undefined ? options.intensity : 1;
  switch (camera) {
    case 'kenburns': {
      const z = 1 + 0.14 * intensity * p;
      vw = W / z; vh = H / z;
      vx = (W - vw) * (0.5 + 0.3 * Math.sin(p * Math.PI));
      vy = (H - vh) * 0.5;
      break;
    }
    case 'zoomIn': { const z = 1 + 0.2 * intensity * p; vw = W / z; vh = H / z; vx = (W - vw) / 2; vy = (H - vh) / 2; break; }
    case 'zoomOut': { const z = 1 + 0.2 * intensity * (1 - p); vw = W / z; vh = H / z; vx = (W - vw) / 2; vy = (H - vh) / 2; break; }
    case 'panLeft': { vw = W * 0.86; vh = H * 0.86; vx = (W - vw) * (1 - p); vy = (H - vh) / 2; break; }
    case 'panRight': { vw = W * 0.86; vh = H * 0.86; vx = (W - vw) * p; vy = (H - vh) / 2; break; }
    case 'panUp': { vw = W * 0.9; vh = H * 0.9; vx = (W - vw) / 2; vy = (H - vh) * (1 - p); break; }
    case 'panDown': { vw = W * 0.9; vh = H * 0.9; vx = (W - vw) / 2; vy = (H - vh) * p; break; }
    default: return canvas;
  }
  return extractViewport(canvas, { x: vx, y: vy, w: vw, h: vh }, W, H);
}

// ---------------------------------------------------------------------------
// Scene / frame composition
// ---------------------------------------------------------------------------

export function renderSceneFrame(scene, local, ctx) {
  const canvas = createCanvas(ctx.width, ctx.height, '#000000');
  drawBackground(canvas, scene.background, ctx);

  const progress = scene.duration ? local / scene.duration : 0;
  const nonFixed = (scene.layers || []).filter((l) => !l.fixed).sort((a, b) => a.z - b.z);
  const fixed = (scene.layers || []).filter((l) => l.fixed).sort((a, b) => a.z - b.z);

  for (const layer of nonFixed) {
    drawLayer(canvas, layer, computeAnimation(layer.animate, local), ctx);
  }

  let composited = canvas;
  if (scene.camera && scene.camera !== 'static') {
    composited = applyCamera(canvas, scene.camera, scene.cameraOptions, progress);
  }

  for (const layer of fixed) {
    drawLayer(composited, layer, computeAnimation(layer.animate, local), ctx);
  }

  // grading
  const grade = scene.grade || {};
  if (grade.vignette) vignette(composited, grade.vignette);
  if (grade.tint) tint(composited, grade.tint.color || '#000000', grade.tint.amount || 0.2);
  if (grade.noise) addNoise(composited, grade.noise, ctx.rng);
  return composited;
}

function transition(name, a, b, t) {
  if (name === 'dip') {
    const black = createCanvas(a.width, a.height, '#000000');
    return t < 0.5 ? crossfade(a, black, t * 2) : crossfade(black, b, (t - 0.5) * 2);
  }
  return applyTransition(name, a, b, t);
}

export function renderFrame(timeline, time, ctx) {
  const found = sceneAt(timeline, time);
  if (!found) return createCanvas(ctx.width, ctx.height, '#000000');
  const { scene, index, local } = found;
  const current = renderSceneFrame(scene, local, ctx);
  const tin = scene.transitionIn;
  if (index > 0 && tin && tin.type !== 'none' && tin.duration > 0 && local < tin.duration) {
    const prevScene = timeline.scenes[index - 1];
    const prev = renderSceneFrame(prevScene, prevScene.duration, ctx);
    return transition(tin.type, prev, current, local / tin.duration);
  }
  return current;
}

// ---------------------------------------------------------------------------
// Full render
// ---------------------------------------------------------------------------

/**
 * Render a timeline to in-memory frames + audio.
 * @param {object} timeline
 * @param {object} [options]
 * @param {Map<string, object>} [options.assets]  src → canvas.
 * @param {(done:number,total:number)=>void} [options.onProgress]
 * @param {boolean} [options.includeAudio=true]
 * @returns {{timeline:object, frames:object[], audio:object|null, width:number, height:number, fps:number, duration:number}}
 */
export function renderTimeline(timeline, options = {}) {
  const tl = normalizeTimeline(timeline);
  const { width, height, duration } = tl.meta;
  const fps = options.fps ? Math.max(1, Math.round(options.fps)) : tl.meta.fps;
  const totalFrames = Math.max(1, Math.round(duration * fps));
  const ctx = {
    width,
    height,
    fps,
    assets: options.assets || new Map(),
    rng: createRng(tl.meta.seed || 'render'),
  };
  const frames = [];
  for (let i = 0; i < totalFrames; i++) {
    frames.push(renderFrame(tl, i / fps, ctx));
    if (options.onProgress) options.onProgress(i + 1, totalFrames);
  }
  let audio = null;
  if (tl.audio && tl.audio.enabled && options.includeAudio !== false) {
    audio = composeMusic({
      seed: tl.audio.seed,
      seconds: duration,
      mood: tl.audio.mood,
      tempo: tl.audio.tempo,
      gain: tl.audio.gain,
      sampleRate: options.sampleRate || 22050,
    });
  }
  return { timeline: tl, frames, audio, width, height, fps, duration };
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------

export function framesToGif(frames, { width, height, fps, dither = false, lutBits = 6, scale = 1, gifFps = null, maxFrames = null } = {}) {
  let outFrames = frames;
  let outFps = fps;
  // Optional frame subsampling to keep the preview light.
  if (gifFps && gifFps < fps) {
    const step = fps / gifFps;
    const picked = [];
    for (let i = 0; i < frames.length; i += step) picked.push(frames[Math.round(i)]);
    outFrames = picked;
    outFps = gifFps;
  }
  if (maxFrames && outFrames.length > maxFrames) {
    const step = outFrames.length / maxFrames;
    const picked = [];
    for (let i = 0; i < maxFrames; i += 1) picked.push(outFrames[Math.round(i * step)]);
    outFrames = picked;
    outFps = Math.max(4, Math.round(outFps / step));
  }
  let outW = width;
  let outH = height;
  if (scale && scale < 1) {
    outW = Math.max(2, Math.round(width * scale));
    outH = Math.max(2, Math.round(height * scale));
    outFrames = outFrames.map((f) => resizeCanvas(f, outW, outH));
  }
  const delayMs = 1000 / outFps;
  return encodeGif({
    width: outW,
    height: outH,
    frames: outFrames.map((f) => ({ data: f.data, delayMs })),
    loop: 0,
    dither,
    lutBits,
  });
}

export function framesToAvi(frames, audio, { width, height, fps, quality = 82 } = {}) {
  const jpegs = frames.map((f) => encodeJpeg({ width, height, data: f.data, quality, subsample: '420' }));
  let audioSpec = null;
  if (audio) {
    const stereo = upmix(audio, 2);
    audioSpec = { sampleRate: stereo.sampleRate, channels: 2, data: toInt16(stereo) };
  }
  return encodeAvi({ width, height, fps, frames: jpegs, audio: audioSpec });
}

export function framesToPngSequence(frames) {
  return frames.map((f, i) => ({
    name: `frame_${String(i).padStart(5, '0')}.png`,
    buffer: encodePng(f),
  }));
}

/**
 * Render a timeline and encode the requested artefacts.
 * @param {object} timeline
 * @param {object} options
 * @param {'gif'|'avi'|'png'|'all'} [options.format='gif']
 * @returns {{timeline:object, manifest:object, gif?:Buffer, avi?:Buffer, pngs?:Array, audio?:object}}
 */
export function renderToArtifacts(timeline, options = {}) {
  const format = options.format || 'gif';
  const rendered = renderTimeline(timeline, options);
  const { frames, audio, width, height, fps, duration } = rendered;
  const out = { timeline: rendered.timeline, frames, audio, width, height, fps, duration, manifest: null };
  const wantGif = format === 'gif' || format === 'all';
  const wantAvi = format === 'avi' || format === 'all';
  const wantPng = format === 'png' || format === 'all';
  if (wantGif) out.gif = framesToGif(frames, { width, height, fps, dither: options.dither });
  if (wantAvi) out.avi = framesToAvi(frames, audio, { width, height, fps, quality: options.quality });
  if (wantPng) out.pngs = framesToPngSequence(frames);
  out.manifest = {
    title: rendered.timeline.meta.title,
    width,
    height,
    fps,
    duration,
    frameCount: frames.length,
    hasAudio: !!audio,
    formats: [wantGif && 'gif', wantAvi && 'avi', wantPng && 'png'].filter(Boolean),
    generatedAt: new Date().toISOString(),
  };
  return out;
}

export { validateTimeline, normalizeTimeline };
