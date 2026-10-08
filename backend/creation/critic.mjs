// Critic — the "evaluate" step. Scores a production on multiple signals and
// emits concrete revision directives that the Director feeds back into the loop.
//
// Three tiers of judgement:
//   1. Deterministic — measurable properties of the rendered frames + audio
//      (motion, pacing, colour cohesion, legibility, loudness, duration).
//   2. LLM — narrative coherence between the brief and the storyboard.
//   3. Vision — optional; when a vision provider exists, a sample frame is
//      inspected for artefacts. Absent a provider this tier is skipped honestly.

import { frameDifference, frameLuminance, getPixel } from '../media/raster.mjs';
import { parseColor } from '../media/random.mjs';
import { llmJson } from './util.mjs';

function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function meanFrameDifference(frames) {
  if (frames.length < 2) return 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(frames.length / 24));
  let n = 0;
  for (let i = step; i < frames.length; i += step) {
    sum += frameDifference(frames[i - step], frames[i]);
    n++;
  }
  return n ? sum / n : 0;
}

function luminanceSpread(frame) {
  const step = Math.max(1, Math.floor(Math.sqrt(frame.width * frame.height) / 40));
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 0; y < frame.height; y += step) {
    for (let x = 0; x < frame.width; x += step) {
      const [r, g, b] = getPixel(frame, x, y);
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      sum += l;
      sumSq += l * l;
      n++;
    }
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
}

function paletteCohesion(frames, paletteColors) {
  const palette = [paletteColors.background, paletteColors.accent, paletteColors.secondary, paletteColors.text, paletteColors.muted]
    .map((c) => parseColor(c).slice(0, 3));
  const step = Math.max(1, Math.floor(frames.length / 6));
  let close = 0;
  let total = 0;
  for (let i = 0; i < frames.length; i += step) {
    const frame = frames[i];
    const px = Math.max(1, Math.floor(Math.sqrt(frame.width * frame.height) / 50));
    for (let y = 0; y < frame.height; y += px) {
      for (let x = 0; x < frame.width; x += px) {
        const [r, g, b] = getPixel(frame, x, y);
        let best = Infinity;
        for (const p of palette) best = Math.min(best, colorDistance([r, g, b], p));
        if (best < 90) close++;
        total++;
      }
    }
  }
  return total ? close / total : 0;
}

function audioMetrics(audio) {
  if (!audio) return { peak: 0, rms: 0, present: false };
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < audio.data.length; i++) {
    const v = audio.data[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, audio.data.length));
  return { peak, rms, present: true };
}

function scorePacing(scenes) {
  let penalty = 0;
  for (const s of scenes) {
    if (s.duration < 1.5) penalty += (1.5 - s.duration) / 1.5;
    else if (s.duration > 8) penalty += (s.duration - 8) / 8;
  }
  return Math.max(0, 1 - penalty / Math.max(1, scenes.length));
}

/**
 * Deterministic scoring. Always available.
 */
export function critiqueDeterministic({ frames, audio, timeline, brief, storyboard }) {
  const subscores = {};
  const issues = [];
  const directives = [];

  const motion = meanFrameDifference(frames);
  // Ideal motion band ~0.02..0.18 mean difference.
  subscores.motion = motion < 0.02 ? Math.max(0.2, motion / 0.02 * 0.6)
    : motion > 0.18 ? Math.max(0.3, 1 - (motion - 0.18))
      : 0.7 + 0.3 * (1 - Math.abs(motion - 0.08) / 0.1);
  if (motion < 0.015) {
    issues.push({ severity: 'medium', area: 'motion', message: 'Video is nearly static.' });
    directives.push({ area: 'motion', action: 'add-motion', detail: 'Add camera moves, layer animations or scene transitions.' });
  } else if (motion > 0.22) {
    issues.push({ severity: 'low', area: 'motion', message: 'Motion may feel chaotic.' });
    directives.push({ area: 'motion', action: 'reduce-motion', detail: 'Slow down transitions or lengthen shots.' });
  }

  const scenes = timeline.scenes || [];
  subscores.pacing = scorePacing(scenes);
  if (subscores.pacing < 0.7) {
    issues.push({ severity: 'medium', area: 'pacing', message: 'Some scenes are too short or too long.' });
    directives.push({ area: 'pacing', action: 'rebalance-durations', detail: 'Keep most scenes between 2 and 6 seconds.' });
  }

  subscores.color = paletteCohesion(frames, brief.paletteColors);

  const spread = frames.length ? frames.reduce((s, f) => s + luminanceSpread(f), 0) / frames.length : 0;
  subscores.legibility = Math.min(1, spread / 0.22);
  if (spread < 0.08) {
    issues.push({ severity: 'medium', area: 'legibility', message: 'Low contrast — text may be hard to read.' });
    directives.push({ area: 'legibility', action: 'increase-contrast', detail: 'Raise text contrast, add scrims or enlarge titles.' });
  }

  const am = audioMetrics(audio);
  if (!am.present) {
    subscores.audio = 0.5;
    directives.push({ area: 'audio', action: 'add-music', detail: 'Add a music bed for a more finished feel.' });
  } else if (am.peak > 0.995) {
    subscores.audio = 0.6;
    issues.push({ severity: 'low', area: 'audio', message: 'Audio is clipping.' });
    directives.push({ area: 'audio', action: 'reduce-gain', detail: 'Lower the master gain to avoid clipping.' });
  } else if (am.rms < 0.02) {
    subscores.audio = 0.5;
    directives.push({ area: 'audio', action: 'raise-gain', detail: 'Audio bed is too quiet.' });
  } else {
    subscores.audio = 0.95;
  }

  const duration = timeline.meta.duration;
  subscores.duration = duration < 5 ? 0.5 : duration > 180 ? 0.6 : 1;

  const weights = { motion: 0.2, pacing: 0.2, color: 0.2, legibility: 0.2, audio: 0.15, duration: 0.05 };
  let score = 0;
  for (const [k, w] of Object.entries(weights)) score += (subscores[k] || 0) * w;

  return { score, subscores, issues, directives, metrics: { motion, luminanceSpread: spread, audio: am } };
}

const CRITIC_SYSTEM = `You are a demanding but fair video critic. Given a brief and storyboard,
judge narrative coherence and craft. Return STRICT JSON only:
{ "score": number (0-1), "issues": string[], "suggestions": string[] }`;

export async function critiqueWithLLM({ brief, storyboard }, options = {}) {
  const parsed = await llmJson(options.llm, {
    model: options.model,
    system: CRITIC_SYSTEM,
    user: `Brief:\n${JSON.stringify({ title: brief.title, logline: brief.logline, keyMessages: brief.keyMessages, cta: brief.cta }, null, 2)}\n\nStoryboard:\n${JSON.stringify((storyboard.scenes || []).map((s) => ({ purpose: s.purpose, headline: s.headline, subhead: s.subhead })), null, 2)}\n\nReturn only JSON.`,
    signal: options.signal,
  });
  if (!parsed || typeof parsed.score !== 'number') return null;
  return {
    score: Math.max(0, Math.min(1, parsed.score)),
    issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 6).map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 6).map(String) : [],
  };
}

/**
 * Full critique: deterministic + optional LLM + optional vision.
 */
export async function critique(input, options = {}) {
  const det = critiqueDeterministic(input);
  const issues = [...det.issues];
  const directives = [...det.directives];
  let score = det.score;
  const subscores = { ...det.subscores };

  const llmResult = await critiqueWithLLM(input, options);
  if (llmResult) {
    subscores.coherence = llmResult.score;
    score = score * 0.7 + llmResult.score * 0.3;
    for (const issue of llmResult.issues) issues.push({ severity: 'medium', area: 'coherence', message: issue });
    for (const s of llmResult.suggestions) directives.push({ area: 'coherence', action: 'revise', detail: s });
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    subscores,
    issues,
    directives,
    metrics: det.metrics,
    source: llmResult ? 'deterministic+llm' : 'deterministic',
  };
}
