export const ARABIC_LOCALE = 'ar-SA';

export type VoiceAvailability = { speechRecognition: boolean; speechSynthesis: boolean; locale: string };

export function getVoiceAvailability(scope: any = globalThis): VoiceAvailability {
  return {
    speechRecognition: Boolean(scope?.SpeechRecognition || scope?.webkitSpeechRecognition),
    speechSynthesis: Boolean(scope?.speechSynthesis),
    locale: ARABIC_LOCALE,
  };
}

export function normalizeVoiceText(value: unknown, maxLength = 20_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('VOICE_TEXT_REQUIRED');
  const text = value.normalize('NFC').trim();
  if (text.length > maxLength) throw new Error('VOICE_TEXT_TOO_LONG');
  return text;
}

export function createArabicSpeechRecognition(scope: any = globalThis): any {
  const Constructor = scope?.SpeechRecognition || scope?.webkitSpeechRecognition;
  if (!Constructor) throw new Error('VOICE_RECOGNITION_UNAVAILABLE');
  const recognition = new Constructor();
  recognition.lang = ARABIC_LOCALE;
  recognition.interimResults = false;
  recognition.continuous = false;
  return recognition;
}

export function speakArabic(text: unknown, scope: any = globalThis): void {
  const value = normalizeVoiceText(text);
  if (!scope?.speechSynthesis || !scope?.SpeechSynthesisUtterance) throw new Error('VOICE_SYNTHESIS_UNAVAILABLE');
  const utterance = new scope.SpeechSynthesisUtterance(value);
  utterance.lang = ARABIC_LOCALE;
  scope.speechSynthesis.cancel();
  scope.speechSynthesis.speak(utterance);
}
