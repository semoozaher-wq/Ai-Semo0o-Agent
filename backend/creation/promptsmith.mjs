// PromptSmith — compiles provider-ready prompts from a shot + the bibles.
//
// Every image/video generation call goes through here so that continuity tokens
// (palette, style, characters, lighting, negative prompt) are ALWAYS applied
// consistently, no matter which provider or shot is being produced.

const CAMERA_PHRASES = {
  static: 'locked-off static camera, stable framing',
  kenburns: 'slow cinematic push-in, gentle parallax',
  zoomIn: 'smooth dolly zoom in, increasing intimacy',
  zoomOut: 'slow reveal pull-back, establishing context',
  panLeft: 'smooth lateral pan to the left',
  panRight: 'smooth lateral pan to the right',
  panUp: 'slow tilt up, sense of scale',
  panDown: 'slow tilt down, grounding the subject',
};

const LIGHTING = {
  uplifting: 'bright, airy, high-key lighting',
  cinematic: 'dramatic chiaroscuro lighting, volumetric haze',
  lofi: 'soft warm ambient light, gentle grain',
  energetic: 'punchy saturated lighting, dynamic highlights',
  calm: 'soft diffused natural light',
  corporate: 'clean neutral studio lighting',
};

export function compileNegativePrompt(bibles) {
  const parts = [bibles?.style?.negativePrompt].filter(Boolean);
  return parts.join(', ');
}

/**
 * Compile the full prompt set for a single shot.
 * @returns {{positive:string, negative:string, style:string, camera:string, aspect:string, characters:string[]}}
 */
export function compileShotPrompts(scene, bibles, brief, options = {}) {
  const style = bibles?.style || {};
  const palette = style.palette || {};
  const sceneVisual = scene.visual || {};
  const camera = scene.camera || sceneVisual.motion || 'static';
  const lighting = LIGHTING[brief.mood] || 'professional lighting';
  const characterTokens = (bibles?.characters?.characters || [])
    .map((c) => c.consistencyTokens)
    .filter(Boolean);

  const positiveParts = [
    sceneVisual.prompt || scene.headline,
    style.styleTokens,
    `${palette.accent || ''} accent against ${palette.background || ''} background`.trim(),
    CAMERA_PHRASES[camera] || CAMERA_PHRASES.static,
    lighting,
    'cinematic composition, professional colour grade, high detail',
  ].filter(Boolean);

  if (characterTokens.length) positiveParts.splice(1, 0, characterTokens.join('; '));

  return {
    positive: positiveParts.join(', '),
    negative: compileNegativePrompt(bibles),
    style: style.styleTokens || '',
    camera,
    aspect: brief.format || 'landscape',
    characters: characterTokens,
  };
}

export function compileVideoPrompt(scene, bibles, brief, options = {}) {
  const base = compileShotPrompts(scene, bibles, brief, options);
  const motion = CAMERA_PHRASES[scene.camera] || CAMERA_PHRASES.static;
  return {
    ...base,
    positive: `${base.positive}, ${motion}, subtle natural motion, coherent temporal consistency`,
    durationSeconds: scene.duration,
  };
}

/** Compile prompts for an entire storyboard. */
export function compileStoryboardPrompts(storyboard, bibles, brief, options = {}) {
  return (storyboard.scenes || []).map((scene) => ({
    sceneId: scene.id,
    image: compileShotPrompts(scene, bibles, brief, options),
    video: compileVideoPrompt(scene, bibles, brief, options),
  }));
}
