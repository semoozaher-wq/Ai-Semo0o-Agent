// Local Studio — the deterministic production engine.
//
// Given a brief, storyboard and bibles, it composes a full Timeline using only
// the dependency-free Creation Kernel: animated gradient/pattern backgrounds,
// motion-graphic motifs, kinetic typography, captions, camera moves and a
// procedural music bed. This is what guarantees that "one goal" ALWAYS yields a
// real, watchable video — even with no external model providers configured.
//
// When an image asset is available for a scene (produced by a provider), the
// Local Studio animates it with a Ken-Burns move instead of a graphic background.

import { FONT_WIDTH, GLYPH_SPACING } from '../media/font.mjs';

/** Choose a font scale so a line fits within maxWidthPx. */
function fitScale(text, maxWidthPx, { min = 1, max = 12, letterSpacing = 1 } = {}) {
  const len = Math.max(1, String(text || '').length);
  const perChar = (FONT_WIDTH + letterSpacing);
  const scale = Math.floor(maxWidthPx / (len * perChar));
  return Math.max(min, Math.min(max, scale));
}

function backgroundFor(scene, brief, style, index) {
  const p = style.palette;
  const variant = index % 3;
  if (variant === 0) {
    return { type: 'gradient', from: p.background, to: p.secondary, angle: 'vertical' };
  }
  if (variant === 1) {
    return { type: 'radial', from: p.secondary, to: p.background, cx: 0.3, cy: 0.3, radius: 0.9 };
  }
  return { type: 'gradient', from: p.background, to: p.accent, angle: 'horizontal' };
}

function motifLayers(scene, brief, style, index, W, H) {
  const p = style.palette;
  const layers = [];
  const variant = index % 3;
  if (variant === 0) {
    layers.push({ type: 'shape', shape: 'circle', x: Math.round(W * 0.78), y: Math.round(H * 0.28), w: Math.round(H * 0.5), h: Math.round(H * 0.5), color: p.accent, opacity: 0.18, z: 0, animate: { type: 'float', duration: 4 } });
    layers.push({ type: 'shape', shape: 'circle', x: Math.round(W * 0.18), y: Math.round(H * 0.8), w: Math.round(H * 0.32), h: Math.round(H * 0.32), color: p.secondary, opacity: 0.22, z: 0, animate: { type: 'pulse', duration: 3 } });
  } else if (variant === 1) {
    for (let i = 0; i < 5; i++) {
      layers.push({ type: 'shape', shape: 'rect', x: Math.round(W * 0.05 + i * W * 0.19), y: Math.round(H * 0.62), w: Math.round(W * 0.05), h: Math.round(H * (0.12 + 0.06 * ((i % 3)))), radius: 6, color: p.accent, opacity: 0.2, z: 0, animate: { type: 'slideUp', delay: 0.1 * i, duration: 0.6 } });
    }
  } else {
    layers.push({ type: 'shape', shape: 'polygon', points: [[W * 0.6, H], [W * 0.8, H * 0.4], [W, H]], color: p.accent, opacity: 0.16, z: 0 });
    layers.push({ type: 'shape', shape: 'polygon', points: [[W * 0.7, H], [W * 0.9, H * 0.55], [W, H]], color: p.secondary, opacity: 0.2, z: 0 });
  }
  return layers;
}

/**
 * Compose a Timeline from the creative inputs.
 * @param {object} input
 * @param {object} input.brief
 * @param {object} input.storyboard
 * @param {object} input.bibles
 * @param {Map<string, object>} [input.assets]  sceneId → canvas (optional).
 * @returns {object} a Timeline (see media/timeline.mjs)
 */
export function composeTimeline({ brief, storyboard, bibles, assets }) {
  const style = bibles.style;
  const W = brief.width;
  const H = brief.height;
  const scenes = (storyboard.scenes || []).map((scene, index) => {
    const hasImage = !!assets && typeof assets.has === 'function' && assets.has(scene.id);
    const background = hasImage
      ? { type: 'image', src: scene.id, fit: 'cover', fallback: style.palette.background }
      : backgroundFor(scene, brief, style, index);

    const layers = [];
    if (!hasImage) {
      layers.push(...motifLayers(scene, brief, style, index, W, H));
    }

    // Accent bar.
    layers.push({
      type: 'shape', shape: 'rect',
      x: Math.round(W * 0.08), y: Math.round(H * 0.30),
      w: Math.round(W * 0.06), h: Math.round(H * 0.012), radius: 4,
      color: style.palette.accent, opacity: 0.95, z: 1,
      animate: { type: 'slideRight', duration: 0.5 },
    });

    // Headline (kinetic typography).
    const headlineScale = fitScale(scene.headline, W * 0.82, { min: 2, max: brief.format === 'portrait' ? 10 : 8 });
    const headlineAnim = scene.role === 'hook' ? 'typewriter' : scene.role === 'cta' ? 'scaleIn' : 'slideUp';
    layers.push({
      type: 'text', text: scene.headline,
      x: Math.round(W * 0.08), y: Math.round(H * 0.36),
      scale: headlineScale, color: style.palette.text,
      align: 'left', anchor: 'top',
      wrap: true, maxWidth: Math.round(W * 0.84),
      shadow: { color: 'rgba(0,0,0,0.55)', dx: 2, dy: 2 },
      opacity: 1, z: 2,
      animate: { type: headlineAnim, delay: 0.15, duration: 0.7, easing: 'easeOutCubic' },
    });

    // Subhead caption with scrim.
    const subScale = fitScale(scene.subhead, W * 0.8, { min: 1, max: brief.format === 'portrait' ? 5 : 3 });
    layers.push({
      type: 'caption', text: scene.subhead,
      x: Math.round(W * 0.08), y: Math.round(H * 0.86),
      scale: subScale, color: style.palette.text,
      align: 'left', anchor: 'bottom',
      background: 'rgba(6,10,16,0.55)', backgroundPadding: 12, backgroundRadius: 8,
      opacity: 1, z: 3,
      animate: { type: 'fadeIn', delay: 0.5, duration: 0.6 },
    });

    return {
      id: scene.id,
      title: scene.purpose,
      duration: scene.duration,
      background,
      camera: scene.camera,
      transitionIn: index === 0 ? { type: 'none', duration: 0 } : { type: scene.transitionIn, duration: 0.5 },
      grade: { vignette: style.grade.vignette, noise: style.grade.noise },
      layers,
    };
  });

  return {
    version: 1,
    meta: {
      title: brief.title,
      goal: brief.goal,
      seed: brief.slug || 'creation',
      width: W,
      height: H,
      fps: brief.fps,
    },
    audio: {
      mood: brief.musicMood || brief.mood,
      seed: `${brief.slug}-music`,
      gain: 0.85,
      enabled: true,
    },
    scenes,
  };
}

export { fitScale };
