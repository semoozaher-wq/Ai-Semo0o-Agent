// Timeline IR — the versioned intermediate representation of a video.
//
// A Timeline is a plain, serialisable description of a movie: metadata, an
// optional audio bed, and an ordered list of scenes. Each scene has a
// background, a camera move, in/out transitions and a stack of layers (text,
// caption, shape, image). The Renderer consumes a normalised Timeline and
// produces frames + audio deterministically.
//
// Keeping this as a stable, versioned IR is what lets the Director, the Local
// Studio, the providers and the frontend all speak the same language.

export const TIMELINE_VERSION = 1;

export const TRANSITIONS = ['none', 'crossfade', 'slide', 'wipe', 'zoom', 'dip'];
export const LAYER_TYPES = ['text', 'caption', 'shape', 'image', 'solid'];
export const ANIMATIONS = ['none', 'fadeIn', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'scaleIn', 'typewriter', 'pulse', 'float'];
export const CAMERAS = ['static', 'kenburns', 'zoomIn', 'zoomOut', 'panLeft', 'panRight', 'panUp', 'panDown'];

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function num(v, fallback) {
  return isFiniteNumber(v) ? v : fallback;
}

/**
 * Create a Timeline from a loose spec, filling in defaults.
 */
export function createTimeline(spec = {}) {
  const width = Math.max(16, Math.round(num(spec.width, 1280)));
  const height = Math.max(16, Math.round(num(spec.height, 720)));
  const fps = Math.max(1, Math.min(60, Math.round(num(spec.fps, 24))));
  const scenes = (spec.scenes || []).map((s, i) => normalizeScene(s, i));
  const timeline = {
    version: TIMELINE_VERSION,
    meta: {
      title: spec.title || 'Untitled',
      goal: spec.goal || '',
      seed: spec.seed || 'semo0o',
      width,
      height,
      fps,
      createdAt: spec.createdAt || new Date().toISOString(),
      ...(spec.meta || {}),
    },
    audio: spec.audio === null ? null : normalizeAudio(spec.audio || {}),
    scenes,
  };
  return normalizeTimeline(timeline);
}

function normalizeAudio(audio) {
  return {
    mood: audio.mood || 'uplifting',
    seed: audio.seed || 'music',
    gain: num(audio.gain, 0.85),
    tempo: audio.tempo,
    enabled: audio.enabled === undefined ? true : !!audio.enabled,
  };
}

function normalizeLayer(layer, index) {
  const type = LAYER_TYPES.includes(layer.type) ? layer.type : 'text';
  const base = {
    id: layer.id || `layer-${index}`,
    type,
    x: num(layer.x, 0),
    y: num(layer.y, 0),
    opacity: num(layer.opacity, 1),
    z: num(layer.z, index),
    fixed: layer.fixed === undefined ? (type === 'text' || type === 'caption') : !!layer.fixed,
    animate: normalizeAnimation(layer.animate),
  };
  if (type === 'text' || type === 'caption') {
    return {
      ...base,
      text: String(layer.text ?? ''),
      scale: Math.max(1, Math.round(num(layer.scale, 2))),
      color: layer.color || '#ffffff',
      align: layer.align || 'left',
      anchor: layer.anchor || (type === 'caption' ? 'bottom' : 'top'),
      wrap: !!layer.wrap,
      maxWidth: num(layer.maxWidth, 0),
      letterSpacing: num(layer.letterSpacing, 0),
      lineSpacing: num(layer.lineSpacing, 2),
      shadow: layer.shadow || null,
      background: layer.background || null,
      backgroundPadding: num(layer.backgroundPadding, 8),
      backgroundRadius: num(layer.backgroundRadius, 6),
      padding: num(layer.padding, 16),
    };
  }
  if (type === 'shape') {
    return {
      ...base,
      shape: layer.shape || 'rect',
      w: num(layer.w, 100),
      h: num(layer.h, 100),
      radius: num(layer.radius, 0),
      color: layer.color || '#ffffff',
      points: layer.points || null,
    };
  }
  if (type === 'image') {
    return {
      ...base,
      src: layer.src || null,
      fit: layer.fit || 'cover',
      kenBurns: layer.kenBurns || null,
      w: num(layer.w, 0),
      h: num(layer.h, 0),
    };
  }
  // solid
  return { ...base, color: layer.color || '#000000', w: num(layer.w, 0), h: num(layer.h, 0) };
}

function normalizeAnimation(anim) {
  if (!anim || anim.type === 'none' || !anim.type) return { type: 'none' };
  const type = ANIMATIONS.includes(anim.type) ? anim.type : 'none';
  return {
    type,
    delay: num(anim.delay, 0),
    duration: num(anim.duration, 0.6),
    from: anim.from,
    to: anim.to,
    easing: anim.easing || 'easeOut',
  };
}

function normalizeScene(scene, index) {
  return {
    id: scene.id || `scene-${index}`,
    title: scene.title || '',
    duration: Math.max(0.1, num(scene.duration, 3)),
    background: scene.background || { type: 'solid', color: '#0b1020' },
    camera: CAMERAS.includes(scene.camera) ? scene.camera : (scene.camera && scene.camera.type) || 'static',
    cameraOptions: (scene.camera && typeof scene.camera === 'object' ? scene.camera : scene.cameraOptions) || {},
    transitionIn: normalizeTransition(scene.transitionIn),
    transitionOut: normalizeTransition(scene.transitionOut),
    grade: scene.grade || {},
    layers: (scene.layers || []).map((l, i) => normalizeLayer(l, i)),
  };
}

function normalizeTransition(t) {
  if (!t) return { type: 'none', duration: 0 };
  if (typeof t === 'string') return { type: TRANSITIONS.includes(t) ? t : 'none', duration: t === 'none' ? 0 : 0.5 };
  const type = TRANSITIONS.includes(t.type) ? t.type : 'none';
  return { type, duration: type === 'none' ? 0 : Math.max(0, num(t.duration, 0.5)) };
}

/**
 * Normalise a timeline in place-safe fashion (returns a new object).
 */
export function normalizeTimeline(timeline) {
  const tl = {
    version: TIMELINE_VERSION,
    meta: { ...timeline.meta },
    audio: timeline.audio === null ? null : normalizeAudio(timeline.audio || {}),
    scenes: (timeline.scenes || []).map((s, i) => normalizeScene(s, i)),
  };
  // Assign sequential start times.
  let cursor = 0;
  for (const scene of tl.scenes) {
    scene.start = cursor;
    cursor += scene.duration;
  }
  tl.meta.duration = cursor;
  tl.meta.totalFrames = Math.max(1, Math.round(cursor * tl.meta.fps));
  return tl;
}

/**
 * Validate a timeline, returning errors and warnings (never throws).
 */
export function validateTimeline(timeline) {
  const errors = [];
  const warnings = [];
  if (!timeline || typeof timeline !== 'object') {
    return { ok: false, errors: ['timeline is not an object'], warnings };
  }
  if (timeline.version !== TIMELINE_VERSION) {
    warnings.push(`timeline version ${timeline.version} != ${TIMELINE_VERSION}`);
  }
  const meta = timeline.meta || {};
  if (!isFiniteNumber(meta.width) || meta.width <= 0) errors.push('meta.width must be a positive number');
  if (!isFiniteNumber(meta.height) || meta.height <= 0) errors.push('meta.height must be a positive number');
  if (!isFiniteNumber(meta.fps) || meta.fps <= 0) errors.push('meta.fps must be a positive number');
  if (!Array.isArray(timeline.scenes) || timeline.scenes.length === 0) {
    errors.push('timeline must contain at least one scene');
  } else {
    timeline.scenes.forEach((scene, i) => {
      if (!isFiniteNumber(scene.duration) || scene.duration <= 0) {
        errors.push(`scene[${i}] has invalid duration`);
      }
      if (!Array.isArray(scene.layers)) warnings.push(`scene[${i}] has no layers`);
      (scene.layers || []).forEach((layer, j) => {
        if (!LAYER_TYPES.includes(layer.type)) errors.push(`scene[${i}].layer[${j}] unknown type "${layer.type}"`);
        if ((layer.type === 'text' || layer.type === 'caption') && typeof layer.text !== 'string') {
          errors.push(`scene[${i}].layer[${j}] text layer requires a string text`);
        }
      });
    });
    const dur = timeline.meta && timeline.meta.duration;
    if (isFiniteNumber(dur) && dur > 600) warnings.push(`timeline duration ${dur}s exceeds 10 minutes`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function timelineDuration(timeline) {
  return (timeline.scenes || []).reduce((sum, s) => sum + (s.duration || 0), 0);
}

/**
 * Return the scene active at a global time, plus its local time.
 */
export function sceneAt(timeline, time) {
  const scenes = timeline.scenes || [];
  if (scenes.length === 0) return null;
  if (time <= 0) return { scene: scenes[0], index: 0, local: 0 };
  let cursor = 0;
  for (let i = 0; i < scenes.length; i++) {
    const end = cursor + scenes[i].duration;
    if (time < end || i === scenes.length - 1) {
      return { scene: scenes[i], index: i, local: Math.max(0, time - cursor) };
    }
    cursor = end;
  }
  return null;
}

/**
 * Serialise a timeline to a stable JSON string.
 */
export function serializeTimeline(timeline) {
  return JSON.stringify(timeline, null, 2);
}

export function parseTimeline(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  return normalizeTimeline(obj);
}
