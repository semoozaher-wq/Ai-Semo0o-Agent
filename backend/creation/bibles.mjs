// Style & Character Bibles — continuity anchors for a whole production.
//
// The single biggest failure mode of AI video is inconsistency: every shot looks
// like a different film. The bibles fix that by pinning a palette, typography,
// motion language and (optionally) recurring characters, then feeding those
// tokens into EVERY prompt the PromptSmith compiles.

import { clampText, llmJson } from './util.mjs';

const NEGATIVE_BASE = 'text, watermark, signature, logo, low quality, blurry, distorted, extra limbs, deformed, jpeg artifacts, oversaturated';

export function buildStyleBible(brief) {
  const palette = brief.paletteColors;
  const energy = { uplifting: 0.7, cinematic: 0.5, lofi: 0.35, energetic: 0.95, calm: 0.3, corporate: 0.6 }[brief.mood] || 0.6;
  return {
    name: `${brief.title} — Visual System`,
    palette: {
      background: palette.background,
      accent: palette.accent,
      secondary: palette.secondary,
      text: palette.text,
      muted: palette.muted,
    },
    typography: {
      titleScale: brief.format === 'portrait' ? 4 : 3,
      bodyScale: brief.format === 'portrait' ? 2 : 1,
      letterSpacing: 1,
      lineSpacing: 3,
      titleColor: palette.text,
      accentColor: palette.accent,
    },
    motion: {
      defaultCamera: energy > 0.7 ? 'zoomIn' : 'kenburns',
      transitionBias: energy > 0.7 ? 'wipe' : 'crossfade',
      energy,
      easing: 'easeOutCubic',
    },
    motifs: [
      `clean geometric shapes in ${palette.accent}`,
      `soft gradient from ${palette.background} to ${palette.secondary}`,
      'generous negative space',
    ],
    tone: brief.tone,
    mood: brief.mood,
    grade: { vignette: energy > 0.6 ? 0.25 : 0.35, noise: 0.01 },
    negativePrompt: NEGATIVE_BASE,
    styleTokens: `${brief.mood} mood, ${brief.tone} tone, cohesive ${brief.palette} colour grade, cinematic composition, professional lighting`,
  };
}

export function buildCharacterBibleDeterministic(brief) {
  return {
    characters: [
      {
        id: 'brand',
        name: brief.title,
        role: 'brand persona',
        description: `The visual identity of "${brief.title}" — ${brief.tone} in tone, ${brief.mood} in mood.`,
        appearance: `consistent ${brief.palette} palette, ${brief.paletteColors.accent} accent, clean modern styling`,
        consistencyTokens: `${brief.palette} palette, ${brief.paletteColors.accent} accent colour, consistent lighting`,
      },
    ],
    source: 'deterministic',
  };
}

const CHARACTER_SYSTEM = `You design consistent characters/mascots for video. Given a brief,
return STRICT JSON only:
{ "characters": [ { "name": string, "role": string, "description": string, "appearance": string, "consistencyTokens": string } ] }
Return 0-2 characters. Only invent characters if the brief clearly needs them (a mascot, presenter
or recurring subject); otherwise return an empty array.`;

export async function buildCharacterBible(brief, options = {}) {
  const parsed = await llmJson(options.llm, {
    model: options.model,
    system: CHARACTER_SYSTEM,
    user: `Brief:\n${JSON.stringify({ title: brief.title, logline: brief.logline, type: brief.type, tone: brief.tone, mood: brief.mood }, null, 2)}\n\nReturn only JSON.`,
    signal: options.signal,
  });
  if (!parsed || !Array.isArray(parsed.characters)) return buildCharacterBibleDeterministic(brief);
  const characters = parsed.characters.slice(0, 2).map((c, i) => ({
    id: `char-${i + 1}`,
    name: clampText(c.name || `Character ${i + 1}`, 40),
    role: clampText(c.role || 'subject', 40),
    description: clampText(c.description || '', 200),
    appearance: clampText(c.appearance || '', 200),
    consistencyTokens: clampText(c.consistencyTokens || c.appearance || '', 200),
  }));
  return { characters, source: characters.length ? 'llm' : 'deterministic' };
}

export function buildBibles(brief, options = {}) {
  return {
    style: buildStyleBible(brief),
    characters: buildCharacterBibleDeterministic(brief),
  };
}

export async function buildBiblesAsync(brief, options = {}) {
  const style = buildStyleBible(brief);
  const characters = await buildCharacterBible(brief, options);
  return { style, characters };
}
