// Video Generation — real text-to-video, image-to-video and conversational
// video editing, built on top of the connector adapters.
//
// This is the single, honest entry point for "make a NEW video with a
// video-generation model". It is deliberately separate from the deterministic
// Local Studio (local-studio.mjs), which composes still frames, kinetic
// typography and camera moves: that is a real, dependency-free deliverable, but
// it is NOT a generative video model and must never be reported as one.
//
// Capability model (reported truthfully, never over-claimed):
//   - textToVideo    : prompt -> a brand-new video (Veo / Replicate / HTTP)
//   - imageToVideo   : image + prompt -> a video with generated motion
//   - videoExtension : continue an existing clip (Veo video-to-video extension)
//   - videoEditing   : restyle / re-scene / re-light EXISTING footage. This needs
//                      a dedicated video-to-video model and is wired through
//                      createVideoEditProvider(). A generation-only backend
//                      (e.g. plain Veo) reports videoEditing = false.

import { createVideoProvider, createVideoEditProvider, connectorStatus } from '../tools/connectors.mjs';
import { llmJson } from './util.mjs';

const EDIT_SYSTEM = [
  'You convert a conversation about editing a video into ONE concrete instruction for a video-to-video editing model.',
  'Reply with a single JSON object and nothing else:',
  '{"operation":"edit"|"extend","instruction":"<concise, visual, imperative instruction>","durationSeconds":<optional number>}',
  'Use "extend" ONLY when the user wants to continue or lengthen the existing clip.',
  'Use "edit" for restyling, re-scening, re-lighting, adding/removing objects, or changing motion.',
  'No commentary, no markdown fences.',
].join(' ');

/** Normalise an arbitrary generation input into the shape the adapters expect. */
export function normalizeVideoInput(input = {}) {
  const out = {};
  if (input.prompt != null) out.prompt = String(input.prompt).slice(0, 20000);
  if (input.negativePrompt != null) out.negativePrompt = String(input.negativePrompt).slice(0, 2000);
  if (input.aspectRatio) out.aspectRatio = String(input.aspectRatio);
  if (input.resolution) out.resolution = String(input.resolution);
  if (input.personGeneration) out.personGeneration = String(input.personGeneration);
  if (Number.isFinite(Number(input.durationSeconds))) out.durationSeconds = Number(input.durationSeconds);
  if (input.image?.base64) out.image = { base64: input.image.base64, mimeType: input.image.mimeType || 'image/png' };
  if (input.video?.base64) out.video = { base64: input.video.base64, mimeType: input.video.mimeType || 'video/mp4' };
  if (input.lastFrame?.base64) out.lastFrame = { base64: input.lastFrame.base64, mimeType: input.lastFrame.mimeType || 'image/png' };
  if (Array.isArray(input.referenceImages)) out.referenceImages = input.referenceImages;
  return out;
}

/**
 * Build the video-generation service from the environment.
 * @returns {object} a service exposing capabilities + textToVideo/imageToVideo/extendVideo/editVideo.
 */
export function createVideoGenerationService(env = process.env) {
  const provider = createVideoProvider(env);
  const editor = createVideoEditProvider(env);
  const providerCaps = provider?.capabilities || {};
  const capabilities = {
    textToVideo: Boolean(provider && providerCaps.textToVideo !== false),
    imageToVideo: Boolean(provider && providerCaps.imageToVideo),
    videoExtension: Boolean(provider && providerCaps.videoExtension),
    videoEditing: Boolean(editor),
  };
  const describe = () => ({
    provider: provider ? { id: provider.id, model: provider.model, capabilities: providerCaps } : null,
    editor: editor ? { id: editor.id, model: editor.model } : null,
    capabilities,
  });
  return {
    provider,
    editor,
    capabilities,
    status() { return { ...describe(), connectors: connectorStatus(env) }; },
    async textToVideo(input = {}) {
      if (!provider) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:video.generate');
      return provider.generate(normalizeVideoInput(input));
    },
    async imageToVideo(input = {}) {
      if (!provider) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:video.generate');
      if (!providerCaps.imageToVideo) throw new Error('VIDEO_IMAGE_TO_VIDEO_UNSUPPORTED');
      const normalized = normalizeVideoInput(input);
      if (!normalized.image?.base64) throw new Error('VIDEO_SOURCE_IMAGE_REQUIRED');
      return provider.generate(normalized);
    },
    async extendVideo(input = {}) {
      if (!provider) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:video.generate');
      if (!providerCaps.videoExtension) throw new Error('VIDEO_EXTENSION_UNSUPPORTED');
      const normalized = normalizeVideoInput(input);
      if (!normalized.video?.base64) throw new Error('VIDEO_SOURCE_REQUIRED');
      return provider.generate(normalized);
    },
    async editVideo(input = {}) {
      if (!editor) throw new Error('TOOL_CONNECTOR_NOT_CONFIGURED:video.edit');
      const normalized = normalizeVideoInput(input);
      if (!normalized.video?.base64) throw new Error('VIDEO_SOURCE_REQUIRED');
      return editor.edit({ video: normalized.video, prompt: normalized.prompt, mimeType: normalized.video.mimeType });
    },
  };
}

/** Normalise a conversation (string or message array) into `{role, content}` turns. */
function normalizeConversation(conversation) {
  if (typeof conversation === 'string') {
    const text = conversation.trim();
    return text ? [{ role: 'user', content: text }] : [];
  }
  if (Array.isArray(conversation)) {
    return conversation
      .map((m) => (typeof m === 'string'
        ? { role: 'user', content: m }
        : { role: m?.role || 'user', content: String(m?.content ?? '') }))
      .filter((m) => m.content.trim());
  }
  return [];
}

/**
 * Turn a conversation into ONE concrete edit instruction. Uses the LLM when
 * available and falls back to a deterministic reading of the last user turn.
 */
async function planVideoEdit({ turns, llm, model, signal }) {
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join('\n');
  const parsed = await llmJson(llm, {
    model,
    signal,
    maxTokens: 400,
    system: EDIT_SYSTEM,
    user: `Conversation:\n${transcript}\n\nReturn the JSON object only.`,
  });
  if (parsed && typeof parsed === 'object') {
    const operation = parsed.operation === 'extend' ? 'extend' : 'edit';
    const instruction = String(parsed.instruction || parsed.prompt || '').trim();
    if (instruction) {
      return {
        operation,
        instruction: instruction.slice(0, 2000),
        durationSeconds: Number.isFinite(Number(parsed.durationSeconds)) ? Number(parsed.durationSeconds) : undefined,
        source: 'llm',
      };
    }
  }
  const lastUser = [...turns].reverse().find((t) => t.role === 'user') || turns[turns.length - 1];
  const instruction = lastUser.content.trim().slice(0, 2000);
  const operation = /(extend|continue|longer|طوّل|أكمل|استمر|مدّد)/i.test(instruction) ? 'extend' : 'edit';
  return { operation, instruction, source: 'deterministic' };
}

/**
 * Conversational video editing: interpret a conversation, then route the edit to
 * a genuine video-to-video provider — or to Veo's real video EXTENSION when the
 * user explicitly asks to continue a clip. Fails closed (with an explicit,
 * honest error) when no configured backend can serve the requested operation.
 *
 * @param {object} input
 * @param {Array|string} input.conversation  the edit conversation.
 * @param {{base64:string,mimeType?:string}} input.sourceVideo  the clip to edit.
 * @param {string} [input.sourceVideoMimeType]
 * @param {object} [input.llm]  optional LLM router (`complete({model,messages})`).
 * @param {string} [input.model]
 * @param {AbortSignal} [input.signal]
 * @param {object} [input.env]
 * @returns {Promise<{provider:string,model:string,mimeType:string,base64:string,operation:string,instruction:string,plan:object}>}
 */
export async function conversationalVideoEdit({
  conversation,
  sourceVideo,
  sourceVideoMimeType,
  llm = null,
  model,
  signal,
  env = process.env,
} = {}) {
  const service = createVideoGenerationService(env);
  const turns = normalizeConversation(conversation);
  if (!turns.length) throw new Error('VIDEO_EDIT_CONVERSATION_REQUIRED');
  const video = sourceVideo?.base64
    ? { base64: sourceVideo.base64, mimeType: sourceVideoMimeType || sourceVideo.mimeType || 'video/mp4' }
    : null;
  if (!video) throw new Error('VIDEO_SOURCE_REQUIRED');

  const plan = await planVideoEdit({ turns, llm, model, signal });

  if (plan.operation === 'extend') {
    if (!service.capabilities.videoExtension) throw new Error('VIDEO_EXTENSION_UNSUPPORTED:configure_a_video_extension_provider');
    const result = await service.extendVideo({ prompt: plan.instruction, video, durationSeconds: plan.durationSeconds });
    return { ...result, operation: 'extend', instruction: plan.instruction, plan };
  }
  if (!service.capabilities.videoEditing) {
    // Honest, explicit failure: a generation-only backend can create new footage
    // but cannot edit existing footage. We never pretend otherwise.
    throw new Error('VIDEO_EDIT_UNSUPPORTED:configure_a_video_to_video_editing_provider');
  }
  const result = await service.editVideo({ prompt: plan.instruction, video });
  return { ...result, operation: 'edit', instruction: plan.instruction, plan };
}
