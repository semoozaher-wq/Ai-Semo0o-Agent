export const ARABIC_LOCALE = 'ar-SA';

export type VoiceAvailability = {
  speechRecognition: boolean;
  speechSynthesis: boolean;
  locale: string;
};

/* -------------------------------------------------------------------------- */
/*  Minimal structural types for the Web Speech API                           */
/* -------------------------------------------------------------------------- */
/* The Web Speech API is not part of every TypeScript lib target, so instead  */
/* of `any` we model the exact subset this module relies on. This keeps the   */
/* helpers type-safe while remaining compatible with the browser globals.     */

export interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export interface SpeechSynthesisUtteranceLike {
  lang: string;
  text: string;
}

export interface SpeechSynthesisLike {
  cancel(): void;
  speak(utterance: SpeechSynthesisUtteranceLike): void;
}

export type SpeechSynthesisUtteranceConstructor = new (
  text: string,
) => SpeechSynthesisUtteranceLike;

/** The subset of the global scope the voice helpers rely on. */
export interface VoiceScope {
  SpeechRecognition?: SpeechRecognitionConstructor | undefined;
  webkitSpeechRecognition?: SpeechRecognitionConstructor | undefined;
  speechSynthesis?: SpeechSynthesisLike | undefined;
  SpeechSynthesisUtterance?: SpeechSynthesisUtteranceConstructor | undefined;
}

function resolveScope(scope?: VoiceScope): VoiceScope {
  return scope ?? (globalThis as unknown as VoiceScope);
}

export function getVoiceAvailability(scope?: VoiceScope): VoiceAvailability {
  const target = resolveScope(scope);
  return {
    speechRecognition: Boolean(
      target.SpeechRecognition ?? target.webkitSpeechRecognition,
    ),
    speechSynthesis: Boolean(target.speechSynthesis),
    locale: ARABIC_LOCALE,
  };
}

export function normalizeVoiceText(value: unknown, maxLength = 20_000): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('VOICE_TEXT_REQUIRED');
  }
  const text = value.normalize('NFC').trim();
  if (text.length > maxLength) throw new Error('VOICE_TEXT_TOO_LONG');
  return text;
}

export function createArabicSpeechRecognition(
  scope?: VoiceScope,
): SpeechRecognitionLike {
  const target = resolveScope(scope);
  const Constructor = target.SpeechRecognition ?? target.webkitSpeechRecognition;
  if (!Constructor) throw new Error('VOICE_RECOGNITION_UNAVAILABLE');
  const recognition = new Constructor();
  recognition.lang = ARABIC_LOCALE;
  recognition.interimResults = false;
  recognition.continuous = false;
  return recognition;
}

export function speakArabic(text: unknown, scope?: VoiceScope): void {
  const target = resolveScope(scope);
  const value = normalizeVoiceText(text);
  const Utterance = target.SpeechSynthesisUtterance;
  if (!target.speechSynthesis || !Utterance) {
    throw new Error('VOICE_SYNTHESIS_UNAVAILABLE');
  }
  const utterance = new Utterance(value);
  utterance.lang = ARABIC_LOCALE;
  target.speechSynthesis.cancel();
  target.speechSynthesis.speak(utterance);
}
