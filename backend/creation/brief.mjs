// Creative Brief — turns ONE goal into a structured, production-ready brief.
//
// This is the first "think" step of the Director loop. It works with an LLM when
// one is available (richer interpretation) and always falls back to a
// deterministic interpreter so the pipeline can never stall.

import { keywords, slugify, titleCase, clampText, clampNumber, sentences, llmJson } from './util.mjs';

export const PALETTES = {
  midnight: { name: 'Midnight', background: '#0b1020', accent: '#60a5fa', secondary: '#1e3a8a', text: '#f8fafc', muted: '#94a3b8' },
  sunrise: { name: 'Sunrise', background: '#1b1030', accent: '#fb923c', secondary: '#f43f5e', text: '#fff7ed', muted: '#fdba74' },
  forest: { name: 'Forest', background: '#04160f', accent: '#34d399', secondary: '#065f46', text: '#ecfdf5', muted: '#6ee7b7' },
  ocean: { name: 'Ocean', background: '#04121f', accent: '#38bdf8', secondary: '#0369a1', text: '#f0f9ff', muted: '#7dd3fc' },
  candy: { name: 'Candy', background: '#1a0b2e', accent: '#e879f9', secondary: '#a21caf', text: '#fdf4ff', muted: '#f0abfc' },
  mono: { name: 'Mono', background: '#0a0a0a', accent: '#e5e5e5', secondary: '#404040', text: '#fafafa', muted: '#a3a3a3' },
  corporate: { name: 'Corporate', background: '#0f172a', accent: '#2563eb', secondary: '#1d4ed8', text: '#f1f5f9', muted: '#94a3b8' },
  neon: { name: 'Neon', background: '#05010f', accent: '#22d3ee', secondary: '#d946ef', text: '#f0fdff', muted: '#67e8f9' },
  sand: { name: 'Sand', background: '#1c1917', accent: '#f59e0b', secondary: '#b45309', text: '#fffbeb', muted: '#fcd34d' },
  rose: { name: 'Rose', background: '#1f0714', accent: '#fb7185', secondary: '#be123c', text: '#fff1f2', muted: '#fda4af' },
};

export const FORMATS = {
  landscape: { label: 'Landscape 16:9', width: 1280, height: 720 },
  portrait: { label: 'Portrait 9:16', width: 720, height: 1280 },
  square: { label: 'Square 1:1', width: 1080, height: 1080 },
  wide: { label: 'Cinematic 21:9', width: 1680, height: 720 },
};

const TYPE_RULES = [
  { type: 'launch', re: /\b(launch|release|announce|unveil|introduc|new\b|اطلاق|إطلاق|نطلق|نعلن|جديد)/i, tone: 'excited', mood: 'uplifting', palette: 'midnight' },
  { type: 'tutorial', re: /\b(how to|tutorial|guide|step by step|learn|explain|دليل|شرح|كيف|خطوات|تعليم)/i, tone: 'clear', mood: 'corporate', palette: 'corporate' },
  { type: 'promo', re: /\b(promo|ad|advert|sell|offer|discount|sale|marketing|عرض|خصم|تسويق|اعلان|إعلان)/i, tone: 'persuasive', mood: 'energetic', palette: 'sunrise' },
  { type: 'story', re: /\b(story|journey|narrative|documentary|قصة|رحلة|حكاية|وثائقي)/i, tone: 'warm', mood: 'cinematic', palette: 'sand' },
  { type: 'social', re: /\b(tiktok|reel|shorts|instagram|social|فيديو قصير|ريلز|تيك توك)/i, tone: 'punchy', mood: 'energetic', palette: 'neon' },
  { type: 'explainer', re: /\b(explainer|overview|what is|intro|presentation|تعريف|نظرة|مقدمة|عرض تقديمي)/i, tone: 'informative', mood: 'calm', palette: 'ocean' },
];

function detectType(goal) {
  for (const rule of TYPE_RULES) {
    if (rule.re.test(goal)) return rule;
  }
  return { type: 'explainer', tone: 'informative', mood: 'uplifting', palette: 'midnight' };
}

function detectFormat(goal) {
  if (/\b(vertical|portrait|reel|tiktok|shorts|story|عمودي|طولي)/i.test(goal)) return 'portrait';
  if (/\b(square|instagram|مربع)/i.test(goal)) return 'square';
  if (/\b(cinematic|wide|film|سينمائي|عريض)/i.test(goal)) return 'wide';
  return 'landscape';
}

function detectDuration(goal, type) {
  const explicit = goal.match(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|ثانية|ثواني|دقيقة|minutes?|min\b)/i);
  if (explicit) {
    const value = parseFloat(explicit[1]);
    const unit = explicit[2].toLowerCase();
    if (/min|دقيقة/.test(unit)) return clampNumber(value * 60, 5, 300, 30);
    return clampNumber(value, 4, 300, 20);
  }
  if (type === 'social') return 15;
  if (type === 'story') return 45;
  if (type === 'tutorial') return 40;
  return 25;
}

/**
 * Deterministic brief interpreter — always available.
 */
export function buildBriefDeterministic(input) {
  const goal = typeof input === 'string' ? input : (input?.goal || '');
  const rule = detectType(goal);
  const formatKey = FORMATS[input && input.format] ? input.format : detectFormat(goal);
  const format = FORMATS[formatKey] || FORMATS.landscape;
  const duration = clampNumber(input?.duration, 4, 300, detectDuration(goal, rule.type));
  const kws = keywords(goal, 8);
  const topic = kws.length ? titleCase(kws.slice(0, 3).join(' ')) : titleCase(goal.split(/\s+/).slice(0, 4).join(' '));
  const paletteKey = PALETTES[input && input.palette] ? input.palette : rule.palette;
  const palette = PALETTES[paletteKey] || PALETTES.midnight;
  const clauses = sentences(goal);

  return {
    goal: goal.trim(),
    title: clampText(topic || 'Untitled Creation', 60),
    logline: clampText(clauses[0] || goal, 140),
    type: rule.type,
    tone: rule.tone,
    mood: rule.mood,
    audience: input?.audience || 'general audience',
    language: input?.language || (/[\u0600-\u06ff]/.test(goal) ? 'ar' : 'en'),
    format: formatKey,
    width: format.width,
    height: format.height,
    fps: clampNumber(input?.fps, 6, 30, 24),
    duration,
    palette: paletteKey,
    paletteColors: palette,
    keywords: kws,
    keyMessages: clauses.slice(0, 3).map((c) => clampText(c, 90)),
    cta: input?.cta || 'Learn more',
    captions: input?.captions === undefined ? true : !!input.captions,
    voiceover: input?.voiceover === undefined ? false : !!input.voiceover,
    musicMood: input?.musicMood || rule.mood,
    aspect: formatKey,
    slug: slugify(topic || goal, 'creation'),
    source: 'deterministic',
  };
}

const BRIEF_SYSTEM = `You are a senior creative director. Given a single goal, produce a concise,
production-ready video brief as STRICT JSON only (no prose, no markdown). Schema:
{
  "title": string (<=60 chars),
  "logline": string (<=140 chars),
  "type": one of "launch"|"tutorial"|"promo"|"story"|"social"|"explainer",
  "tone": string,
  "mood": one of "uplifting"|"cinematic"|"lofi"|"energetic"|"calm"|"corporate",
  "audience": string,
  "duration": number (seconds, 4-300),
  "format": one of "landscape"|"portrait"|"square"|"wide",
  "palette": one of "midnight"|"sunrise"|"forest"|"ocean"|"candy"|"mono"|"corporate"|"neon"|"sand"|"rose",
  "keyMessages": string[] (1-3 short lines),
  "cta": string,
  "sceneBeats": string[] (3-7 short scene ideas, each one sentence)
}`;

/**
 * Build a brief using the LLM when available, always falling back to the
 * deterministic interpreter. The result is validated and merged over defaults.
 */
export async function buildBrief(input, options = {}) {
  const base = buildBriefDeterministic(input);
  const goal = typeof input === 'string' ? input : (input?.goal || '');
  const parsed = await llmJson(options.llm, {
    model: options.model,
    system: BRIEF_SYSTEM,
    user: `Goal: ${goal}\n\nReturn only the JSON brief.`,
    signal: options.signal,
  });
  if (!parsed || typeof parsed !== 'object') return applyBriefOverrides(base, options);

  const formatKey = FORMATS[parsed.format] ? parsed.format : base.format;
  const format = FORMATS[formatKey];
  const paletteKey = PALETTES[parsed.palette] ? parsed.palette : base.palette;
  const merged = {
    ...base,
    title: clampText(parsed.title || base.title, 60),
    logline: clampText(parsed.logline || base.logline, 140),
    type: TYPE_RULES.some((r) => r.type === parsed.type) ? parsed.type : base.type,
    tone: clampText(parsed.tone || base.tone, 40),
    mood: ['uplifting', 'cinematic', 'lofi', 'energetic', 'calm', 'corporate'].includes(parsed.mood) ? parsed.mood : base.mood,
    audience: clampText(parsed.audience || base.audience, 60),
    duration: clampNumber(parsed.duration, 4, 300, base.duration),
    format: formatKey,
    width: format.width,
    height: format.height,
    palette: paletteKey,
    paletteColors: PALETTES[paletteKey],
    keyMessages: Array.isArray(parsed.keyMessages) && parsed.keyMessages.length
      ? parsed.keyMessages.slice(0, 3).map((m) => clampText(m, 90))
      : base.keyMessages,
    cta: clampText(parsed.cta || base.cta, 40),
    sceneBeats: Array.isArray(parsed.sceneBeats) ? parsed.sceneBeats.slice(0, 7).map((s) => clampText(s, 120)) : undefined,
    source: 'llm',
  };
  // Explicit caller options always win over both the heuristic and the model.
  return applyBriefOverrides(merged, options);
}

/**
 * Apply caller-supplied overrides (format/duration/palette/fps/audience/...)
 * on top of a brief. Validated against the canonical tables so an unknown enum
 * can never leak through. Used so that an explicit request always beats the
 * model's or the heuristic's guess.
 */
export function applyBriefOverrides(brief, options = {}) {
  const next = { ...brief };
  if (FORMATS[options.format]) {
    next.format = options.format;
    next.aspect = options.format;
    next.width = FORMATS[options.format].width;
    next.height = FORMATS[options.format].height;
  }
  if (PALETTES[options.palette]) { next.palette = options.palette; next.paletteColors = PALETTES[options.palette]; }
  if (Number.isFinite(Number(options.duration))) next.duration = clampNumber(options.duration, 4, 300, next.duration);
  if (Number.isFinite(Number(options.fps))) next.fps = clampNumber(options.fps, 6, 30, next.fps);
  if (typeof options.audience === 'string' && options.audience.trim()) next.audience = clampText(options.audience, 60);
  if (typeof options.musicMood === 'string' && options.musicMood.trim()) next.musicMood = options.musicMood.trim();
  if (typeof options.cta === 'string' && options.cta.trim()) next.cta = clampText(options.cta, 40);
  if (options.captions !== undefined) next.captions = !!options.captions;
  if (options.voiceover !== undefined) next.voiceover = !!options.voiceover;
  return next;
}

export function validateBrief(brief) {
  const errors = [];
  if (!brief || typeof brief !== 'object') return { ok: false, errors: ['brief is not an object'] };
  if (!brief.title) errors.push('title is required');
  if (!(brief.width > 0 && brief.height > 0)) errors.push('width/height must be positive');
  if (!(brief.duration > 0)) errors.push('duration must be positive');
  return { ok: errors.length === 0, errors };
}
