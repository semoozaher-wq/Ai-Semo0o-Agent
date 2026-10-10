// Creation Providers — a capability-oriented facade over the connectors.
//
// The Director never talks to a raw connector; it asks for a CAPABILITY
// ("can you make an image?", "can you score audio?") and gets either a working
// adapter or null. This keeps the pipeline honest: when a provider is missing we
// fall back to the deterministic Local Studio instead of faking success.

import {
  createImageProvider,
  createVisionProvider,
  createTextToSpeechProvider,
  createVideoProvider,
  createVideoEditProvider,
  createAudioProvider,
  createMediaAnalysisProvider,
  connectorStatus,
} from '../tools/connectors.mjs';
import { decodePng } from '../media/png.mjs';
import { decodeJpeg } from '../media/jpeg.mjs';
import { canvasFromBuffer } from '../media/raster.mjs';

/** Decode PNG or JPEG bytes into a raster canvas. */
export function decodeImageBytes(bytes, mimeType) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const d = decodePng(buf);
    return canvasFromBuffer(d.width, d.height, d.data);
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const d = decodeJpeg(buf);
    return canvasFromBuffer(d.width, d.height, d.data);
  }
  throw new Error(`CREATION_UNSUPPORTED_IMAGE_FORMAT:${mimeType || 'unknown'}`);
}

/**
 * Build the creation provider set from the environment.
 * @returns {{image:object|null, vision:object|null, tts:object|null, video:object|null, music:object|null, mediaAnalysis:object|null, capabilities:object, status:Function}}
 */
export function createCreationProviders(env = process.env) {
  const image = createImageProvider(env);
  const vision = createVisionProvider(env);
  const tts = createTextToSpeechProvider(env);
  const video = createVideoProvider(env);
  const videoEdit = createVideoEditProvider(env);
  const music = createAudioProvider(env);
  const mediaAnalysis = createMediaAnalysisProvider(env);

  const imageAdapter = image
    ? {
      id: image.id,
      model: image.model,
      async generate({ prompt, size, negativePrompt }) {
        const result = await image.generate({ prompt, size, negativePrompt });
        const bytes = Buffer.from(result.base64, 'base64');
        let canvas = null;
        try {
          canvas = decodeImageBytes(bytes, result.mimeType);
        } catch {
          canvas = null;
        }
        return { ...result, bytes, canvas };
      },
    }
    : null;

  const visionAdapter = vision
    ? { id: vision.id, model: vision.model, analyze: (input) => vision.analyze(input) }
    : null;

  const ttsAdapter = tts
    ? { id: tts.id, model: tts.model, synthesize: (input) => tts.synthesize(input) }
    : null;

  const videoAdapter = video
    ? { id: video.id, model: video.model, capabilities: video.capabilities || {}, generate: (input) => video.generate(input) }
    : null;

  const videoEditAdapter = videoEdit
    ? { id: videoEdit.id, model: videoEdit.model, edit: (input) => videoEdit.edit(input) }
    : null;

  const musicAdapter = music
    ? { id: music.id, model: music.model, generate: (input) => music.generate(input) }
    : null;

  const analysisAdapter = mediaAnalysis
    ? { id: mediaAnalysis.id, model: mediaAnalysis.model, analyze: (input) => mediaAnalysis.analyze(input) }
    : null;

  const capabilities = {
    image: !!imageAdapter,
    vision: !!visionAdapter,
    tts: !!ttsAdapter,
    video: !!videoAdapter,
    videoEdit: !!videoEditAdapter,
    music: !!musicAdapter,
    mediaAnalysis: !!analysisAdapter,
  };

  return {
    image: imageAdapter,
    vision: visionAdapter,
    tts: ttsAdapter,
    video: videoAdapter,
    videoEdit: videoEditAdapter,
    music: musicAdapter,
    mediaAnalysis: analysisAdapter,
    capabilities,
    status() {
      return {
        capabilities,
        connectors: connectorStatus(env),
        localStudio: true,
      };
    },
  };
}

/** A no-provider set: only the deterministic Local Studio is available. */
export function createLocalOnlyProviders() {
  return {
    image: null,
    vision: null,
    tts: null,
    video: null,
    videoEdit: null,
    music: null,
    mediaAnalysis: null,
    capabilities: { image: false, vision: false, tts: false, video: false, videoEdit: false, music: false, mediaAnalysis: false },
    status() {
      return { capabilities: this.capabilities, connectors: {}, localStudio: true };
    },
  };
}
