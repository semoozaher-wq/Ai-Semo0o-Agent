// Storyboard — turns a Creative Brief into an ordered list of scenes/shots.
//
// A storyboard is the bridge between "what we want to say" (brief) and "how it
// looks and moves" (timeline). Each scene carries a purpose, copy, a visual
// direction (which the PromptSmith compiles into provider prompts) and motion
// metadata (camera + transition).

import { clampText, clampNumber, titleCase, keywords, llmJson } from './util.mjs';

const CAMERA_CYCLE = ['kenburns', 'zoomIn', 'panRight', 'zoomOut', 'panLeft', 'static'];
const TRANSITION_CYCLE = ['crossfade', 'wipe', 'slide', 'crossfade', 'zoom', 'dip'];

function beatTemplates(type) {
  switch (type) {
    case 'launch':
      return [
        { purpose: 'hook', role: 'hook' },
        { purpose: 'promise', role: 'promise' },
        { purpose: 'feature', role: 'feature' },
        { purpose: 'feature', role: 'feature' },
        { purpose: 'proof', role: 'proof' },
        { purpose: 'cta', role: 'cta' },
      ];
    case 'tutorial':
      return [
        { purpose: 'hook', role: 'hook' },
        { purpose: 'step', role: 'step' },
        { purpose: 'step', role: 'step' },
        { purpose: 'step', role: 'step' },
        { purpose: 'recap', role: 'cta' },
      ];
    case 'promo':
      return [
        { purpose: 'hook', role: 'hook' },
        { purpose: 'problem', role: 'problem' },
        { purpose: 'solution', role: 'promise' },
        { purpose: 'benefit', role: 'feature' },
        { purpose: 'cta', role: 'cta' },
      ];
    case 'story':
      return [
        { purpose: 'setup', role: 'hook' },
        { purpose: 'journey', role: 'step' },
        { purpose: 'turning point', role: 'feature' },
        { purpose: 'resolution', role: 'promise' },
        { purpose: 'reflection', role: 'cta' },
      ];
    case 'social':
      return [
        { purpose: 'hook', role: 'hook' },
        { purpose: 'point', role: 'feature' },
        { purpose: 'point', role: 'feature' },
        { purpose: 'cta', role: 'cta' },
      ];
    default:
      return [
        { purpose: 'intro', role: 'hook' },
        { purpose: 'context', role: 'promise' },
        { purpose: 'detail', role: 'feature' },
        { purpose: 'detail', role: 'feature' },
        { purpose: 'summary', role: 'cta' },
      ];
  }
}

function copyFor(role, brief, index, total) {
  const msgs = brief.keyMessages && brief.keyMessages.length ? brief.keyMessages : [brief.logline];
  const kw = brief.keywords && brief.keywords.length ? brief.keywords : [];
  switch (role) {
    case 'hook':
      return { headline: clampText(brief.title, 42), subhead: clampText(brief.logline, 90) };
    case 'promise':
      return { headline: 'Why it matters', subhead: clampText(msgs[0] || brief.logline, 90) };
    case 'problem':
      return { headline: 'The challenge', subhead: clampText(msgs[0] || 'It should be easier.', 90) };
    case 'feature':
      return {
        headline: clampText(kw[index % Math.max(1, kw.length)] ? titleCase(kw[index % kw.length]) : `Point ${index}`, 32),
        subhead: clampText(msgs[(index - 1 + msgs.length) % msgs.length] || brief.logline, 90),
      };
    case 'step':
      return { headline: `Step ${index}`, subhead: clampText(msgs[(index - 1 + msgs.length) % msgs.length] || brief.logline, 90) };
    case 'proof':
      return { headline: 'Built to deliver', subhead: clampText(msgs[msgs.length - 1] || 'Real results.', 90) };
    case 'recap':
      return { headline: 'Recap', subhead: clampText(msgs[0] || brief.logline, 90) };
    case 'cta':
      return { headline: clampText(brief.cta || 'Get started', 32), subhead: clampText(brief.title, 80) };
    default:
      return { headline: clampText(brief.title, 42), subhead: clampText(brief.logline, 90) };
  }
}

/**
 * Deterministic storyboard builder.
 */
export function buildStoryboardDeterministic(brief, options = {}) {
  const beats = beatTemplates(brief.type);
  const maxScenes = clampNumber(options.maxScenes, 3, 9, beats.length);
  const scenes = [];
  const count = Math.min(beats.length, maxScenes);
  const perScene = brief.duration / count;
  for (let i = 0; i < count; i++) {
    const beat = beats[i];
    const copy = copyFor(beat.role, brief, i, count);
    const camera = CAMERA_CYCLE[i % CAMERA_CYCLE.length];
    const transition = i === 0 ? 'none' : TRANSITION_CYCLE[i % TRANSITION_CYCLE.length];
    scenes.push({
      id: `scene-${i + 1}`,
      purpose: beat.purpose,
      role: beat.role,
      headline: copy.headline,
      subhead: copy.subhead,
      duration: Math.round(perScene * 100) / 100,
      camera,
      transitionIn: transition,
      visual: {
        type: 'motion-graphic',
        style: i % 2 === 0 ? 'gradient' : 'pattern',
        prompt: `${brief.title}: ${copy.headline}. ${brief.tone} tone, ${brief.mood} mood, ${brief.palette} palette.`,
        motion: camera,
      },
      caption: copy.subhead,
      accent: brief.paletteColors.accent,
    });
  }
  return { scenes, source: 'deterministic' };
}

const STORYBOARD_SYSTEM = `You are a storyboard artist. Given a video brief, produce an ordered
storyboard as STRICT JSON only. Schema:
{
  "scenes": [
    {
      "purpose": string,
      "headline": string (<=42 chars, on-screen title),
      "subhead": string (<=90 chars),
      "duration": number (seconds, 1.5-8),
      "camera": one of "static"|"kenburns"|"zoomIn"|"zoomOut"|"panLeft"|"panRight"|"panUp"|"panDown",
      "transitionIn": one of "none"|"crossfade"|"slide"|"wipe"|"zoom"|"dip",
      "visualPrompt": string (a vivid, concrete image description, no text/logos)
    }
  ]
}
Produce between 3 and 7 scenes whose durations sum to roughly the requested duration.`;

export async function buildStoryboard(brief, options = {}) {
  const base = buildStoryboardDeterministic(brief, options);
  const parsed = await llmJson(options.llm, {
    model: options.model,
    system: STORYBOARD_SYSTEM,
    user: `Brief:\n${JSON.stringify({ title: brief.title, logline: brief.logline, type: brief.type, tone: brief.tone, mood: brief.mood, duration: brief.duration, keyMessages: brief.keyMessages, cta: brief.cta }, null, 2)}\n\nReturn only the JSON storyboard.`,
    signal: options.signal,
  });
  if (!parsed || !Array.isArray(parsed.scenes) || parsed.scenes.length === 0) return base;

  const scenes = parsed.scenes.slice(0, 8).map((s, i) => {
    const fallback = base.scenes[i % base.scenes.length];
    const camera = CAMERA_CYCLE.includes(s.camera) ? s.camera : fallback.camera;
    const transitionIn = i === 0 ? 'none' : (TRANSITION_CYCLE.includes(s.transitionIn) ? s.transitionIn : fallback.transitionIn);
    return {
      id: `scene-${i + 1}`,
      purpose: clampText(s.purpose || fallback.purpose, 40),
      role: fallback.role,
      headline: clampText(s.headline || fallback.headline, 42),
      subhead: clampText(s.subhead || fallback.subhead, 90),
      duration: clampNumber(s.duration, 1.5, 8, fallback.duration),
      camera,
      transitionIn,
      visual: {
        type: 'motion-graphic',
        style: i % 2 === 0 ? 'gradient' : 'pattern',
        prompt: clampText(s.visualPrompt || fallback.visual.prompt, 240),
        motion: camera,
      },
      caption: clampText(s.subhead || fallback.caption, 90),
      accent: brief.paletteColors.accent,
    };
  });
  return { scenes, source: 'llm' };
}

export function normalizeStoryboard(storyboard, brief) {
  const scenes = (storyboard.scenes || []).map((s, i) => ({
    id: s.id || `scene-${i + 1}`,
    purpose: s.purpose || 'scene',
    role: s.role || 'feature',
    headline: clampText(s.headline || '', 42),
    subhead: clampText(s.subhead || '', 90),
    duration: clampNumber(s.duration, 1.5, 8, 3),
    camera: CAMERA_CYCLE.includes(s.camera) ? s.camera : 'static',
    transitionIn: i === 0 ? 'none' : (TRANSITION_CYCLE.includes(s.transitionIn) ? s.transitionIn : 'crossfade'),
    visual: s.visual || { type: 'motion-graphic', style: 'gradient', prompt: s.headline || '', motion: 'static' },
    caption: clampText(s.caption || s.subhead || '', 90),
    accent: s.accent || (brief?.paletteColors?.accent) || '#60a5fa',
  }));
  return { scenes, source: storyboard.source || 'unknown' };
}

export function validateStoryboard(storyboard) {
  const errors = [];
  if (!storyboard || !Array.isArray(storyboard.scenes)) return { ok: false, errors: ['storyboard.scenes must be an array'] };
  if (storyboard.scenes.length === 0) errors.push('storyboard must contain at least one scene');
  storyboard.scenes.forEach((s, i) => {
    if (!(s.duration > 0)) errors.push(`scene[${i}] duration must be positive`);
    if (!s.headline) errors.push(`scene[${i}] headline is required`);
  });
  return { ok: errors.length === 0, errors };
}
