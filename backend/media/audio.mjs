// PCM audio DSP + procedural music & SFX — dependency-free (Node built-ins only).
//
// Canonical PCM representation: { sampleRate, channels, data: Float32Array }
// where `data` is interleaved and normalised to [-1, 1]. Everything here is
// deterministic given a seed, so a "one goal" render always produces the same
// soundtrack for the same brief.

import { createRng } from './random.mjs';

// ---------------------------------------------------------------------------
// Core PCM helpers
// ---------------------------------------------------------------------------

export function createPcm(sampleRate, channels, frames) {
  return { sampleRate, channels, data: new Float32Array(frames * channels) };
}

export function pcmFrames(pcm) {
  return pcm.data.length / pcm.channels;
}

export function pcmDuration(pcm) {
  return pcmFrames(pcm) / pcm.sampleRate;
}

export function clonePcm(pcm) {
  return { sampleRate: pcm.sampleRate, channels: pcm.channels, data: Float32Array.from(pcm.data) };
}

export function silence(sampleRate, channels, seconds) {
  return createPcm(sampleRate, channels, Math.max(0, Math.round(seconds * sampleRate)));
}

export function fromInt16(buffer, sampleRate, channels) {
  const n = buffer.length >> 1;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = buffer.readInt16LE(i * 2) / 32768;
  return { sampleRate, channels, data };
}

export function toInt16(pcm) {
  const n = pcm.data.length;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let v = pcm.data[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

export function mix(a, b, gainB = 1) {
  const len = Math.max(a.data.length, b.data.length);
  const data = new Float32Array(len);
  data.set(a.data);
  const n = b.data.length;
  for (let i = 0; i < n; i++) data[i] += b.data[i] * gainB;
  return { sampleRate: a.sampleRate, channels: a.channels, data };
}

export function mixInto(dest, src, offsetFrames = 0, gain = 1) {
  const ch = dest.channels;
  const start = offsetFrames * ch;
  for (let i = 0; i < src.data.length; i++) {
    const idx = start + i;
    if (idx >= dest.data.length) break;
    dest.data[idx] += src.data[i] * gain;
  }
  return dest;
}

export function applyGain(pcm, gain) {
  for (let i = 0; i < pcm.data.length; i++) pcm.data[i] *= gain;
  return pcm;
}

export function applyFade(pcm, { inSec = 0, outSec = 0 } = {}) {
  const sr = pcm.sampleRate;
  const ch = pcm.channels;
  const frames = pcmFrames(pcm);
  const inF = Math.min(frames, Math.round(inSec * sr));
  const outF = Math.min(frames, Math.round(outSec * sr));
  for (let f = 0; f < inF; f++) {
    const g = f / inF;
    for (let c = 0; c < ch; c++) pcm.data[f * ch + c] *= g;
  }
  for (let f = 0; f < outF; f++) {
    const g = f / outF;
    const idx = frames - 1 - f;
    for (let c = 0; c < ch; c++) pcm.data[idx * ch + c] *= g;
  }
  return pcm;
}

export function normalize(pcm, target = 0.92) {
  let peak = 0;
  for (let i = 0; i < pcm.data.length; i++) {
    const a = Math.abs(pcm.data[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const g = target / peak;
    for (let i = 0; i < pcm.data.length; i++) pcm.data[i] *= g;
  }
  return pcm;
}

export function resample(pcm, targetRate) {
  if (targetRate === pcm.sampleRate) return clonePcm(pcm);
  const ch = pcm.channels;
  const srcFrames = pcmFrames(pcm);
  const ratio = targetRate / pcm.sampleRate;
  const dstFrames = Math.max(1, Math.round(srcFrames * ratio));
  const data = new Float32Array(dstFrames * ch);
  for (let f = 0; f < dstFrames; f++) {
    const srcPos = f / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(srcFrames - 1, i0 + 1);
    const t = srcPos - i0;
    for (let c = 0; c < ch; c++) {
      const a = pcm.data[i0 * ch + c] || 0;
      const b = pcm.data[i1 * ch + c] || 0;
      data[f * ch + c] = a + (b - a) * t;
    }
  }
  return { sampleRate: targetRate, channels: ch, data };
}

export function concat(...pcms) {
  const list = pcms.filter(Boolean);
  if (list.length === 0) return createPcm(22050, 1, 0);
  const sampleRate = list[0].sampleRate;
  const channels = list[0].channels;
  let total = 0;
  for (const p of list) total += p.data.length;
  const data = new Float32Array(total);
  let o = 0;
  for (const p of list) { data.set(p.data, o); o += p.data.length; }
  return { sampleRate, channels, data };
}

export function duck(pcm, regions) {
  const sr = pcm.sampleRate;
  const ch = pcm.channels;
  const frames = pcmFrames(pcm);
  for (const r of regions) {
    const start = Math.max(0, Math.round(r.at * sr));
    const end = Math.min(frames, Math.round((r.at + (r.duration || 0.3)) * sr));
    const amount = r.amount === undefined ? 0.5 : r.amount;
    for (let f = start; f < end; f++) {
      const p = (f - start) / Math.max(1, end - start);
      const g = 1 - amount * Math.sin(Math.PI * p);
      for (let c = 0; c < ch; c++) pcm.data[f * ch + c] *= g;
    }
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// Oscillators & envelopes
// ---------------------------------------------------------------------------

export function noteFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function oscillator(waveform, phase) {
  const p = phase - Math.floor(phase);
  switch (waveform) {
    case 'sine': return Math.sin(2 * Math.PI * p);
    case 'square': return p < 0.5 ? 1 : -1;
    case 'saw': return 2 * p - 1;
    case 'triangle': return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
    case 'noise': return Math.random() * 2 - 1;
    default: return Math.sin(2 * Math.PI * p);
  }
}

function adsr(t, dur, { attack = 0.01, decay = 0.1, sustain = 0.7, release = 0.2 }) {
  if (t < 0) return 0;
  if (t < attack) return t / attack;
  if (t < attack + decay) return 1 - (1 - sustain) * ((t - attack) / decay);
  if (t < dur) return sustain;
  const r = t - dur;
  if (r < release) return sustain * (1 - r / release);
  return 0;
}

// ---------------------------------------------------------------------------
// Tone & SFX
// ---------------------------------------------------------------------------

/**
 * Generate a single tone.
 * @param {object} spec
 * @param {number} spec.freq
 * @param {number} spec.seconds
 * @param {number} [spec.sampleRate=22050]
 * @param {string} [spec.waveform='sine']
 * @param {number} [spec.gain=0.5]
 * @param {object} [spec.env]
 * @param {number} [spec.detune=0]
 */
export function tone(spec) {
  const sampleRate = spec.sampleRate || 22050;
  const seconds = spec.seconds;
  const frames = Math.round(seconds * sampleRate);
  const pcm = createPcm(sampleRate, 1, frames);
  const env = spec.env || { attack: 0.01, decay: 0.1, sustain: 0.7, release: 0.2 };
  const gain = spec.gain === undefined ? 0.5 : spec.gain;
  const waveform = spec.waveform || 'sine';
  const detune = spec.detune || 0;
  for (let f = 0; f < frames; f++) {
    const t = f / sampleRate;
    const a = oscillator(waveform, spec.freq * t);
    const b = detune ? oscillator(waveform, spec.freq * (1 + detune) * t) : 0;
    pcm.data[f] = ((a + b) / (detune ? 2 : 1)) * adsr(t, seconds, env) * gain;
  }
  return pcm;
}

export function whoosh({ sampleRate = 22050, seconds = 0.7, gain = 0.4 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const pcm = createPcm(sampleRate, 1, frames);
  const rng = createRng('whoosh');
  let lp = 0;
  for (let f = 0; f < frames; f++) {
    const p = f / frames;
    const n = rng.next() * 2 - 1;
    lp += (n - lp) * (0.02 + 0.5 * p); // opening low-pass → airy sweep
    const env = Math.sin(Math.PI * p);
    pcm.data[f] = lp * env * gain;
  }
  return pcm;
}

export function impact({ sampleRate = 22050, seconds = 0.9, gain = 0.7, seed = 'impact' } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const pcm = createPcm(sampleRate, 1, frames);
  const rng = createRng(seed);
  for (let f = 0; f < frames; f++) {
    const t = f / sampleRate;
    const env = Math.exp(-t * 6);
    const sweep = Math.sin(2 * Math.PI * (90 * Math.exp(-t * 8) + 40) * t);
    const noise = (rng.next() * 2 - 1) * Math.exp(-t * 18);
    pcm.data[f] = (sweep * 0.8 + noise * 0.5) * env * gain;
  }
  return pcm;
}

export function riser({ sampleRate = 22050, seconds = 1.5, gain = 0.4 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const pcm = createPcm(sampleRate, 1, frames);
  const rng = createRng('riser');
  let phase = 0;
  for (let f = 0; f < frames; f++) {
    const p = f / frames;
    const freq = 200 + 1400 * p * p;
    phase += freq / sampleRate;
    const toneV = Math.sin(2 * Math.PI * phase);
    const noise = (rng.next() * 2 - 1) * 0.3;
    pcm.data[f] = (toneV * 0.7 + noise) * p * gain;
  }
  return pcm;
}

export function chime({ sampleRate = 22050, seconds = 1.2, freq = 880, gain = 0.5 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const pcm = createPcm(sampleRate, 1, frames);
  const partials = [1, 2.01, 3.03, 4.7];
  const amps = [1, 0.5, 0.25, 0.12];
  for (let f = 0; f < frames; f++) {
    const t = f / sampleRate;
    let s = 0;
    for (let i = 0; i < partials.length; i++) {
      s += Math.sin(2 * Math.PI * freq * partials[i] * t) * amps[i] * Math.exp(-t * (3 + i));
    }
    pcm.data[f] = s * gain;
  }
  return pcm;
}

// ---------------------------------------------------------------------------
// Procedural music
// ---------------------------------------------------------------------------

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
};

const MOODS = {
  uplifting: { scale: 'major', progression: [0, 4, 5, 3], tempo: 104, brightness: 1.0 },
  cinematic: { scale: 'minor', progression: [0, 5, 3, 4], tempo: 76, brightness: 0.7 },
  lofi: { scale: 'dorian', progression: [0, 3, 4, 3], tempo: 82, brightness: 0.55 },
  energetic: { scale: 'pentatonicMinor', progression: [0, 4, 5, 4], tempo: 124, brightness: 1.15 },
  calm: { scale: 'pentatonicMajor', progression: [0, 3, 4, 0], tempo: 68, brightness: 0.85 },
  corporate: { scale: 'major', progression: [0, 5, 3, 4], tempo: 96, brightness: 1.0 },
};

function scaleNote(scale, root, degree) {
  const n = scale.length;
  const octave = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return root + scale[idx] + 12 * octave;
}

function addKick(dest, atFrame, gain) {
  const sr = dest.sampleRate;
  const dur = Math.round(0.22 * sr);
  for (let i = 0; i < dur; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 16);
    const freq = 120 * Math.exp(-t * 22) + 45;
    const v = Math.sin(2 * Math.PI * freq * t) * env * gain;
    const idx = atFrame + i;
    if (idx < pcmFrames(dest)) dest.data[idx] += v;
  }
}

function addHat(dest, atFrame, gain, rng) {
  const sr = dest.sampleRate;
  const dur = Math.round(0.05 * sr);
  for (let i = 0; i < dur; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 90);
    const v = (rng.next() * 2 - 1) * env * gain;
    const idx = atFrame + i;
    if (idx < pcmFrames(dest)) dest.data[idx] += v;
  }
}

function addSnare(dest, atFrame, gain, rng) {
  const sr = dest.sampleRate;
  const dur = Math.round(0.18 * sr);
  for (let i = 0; i < dur; i++) {
    const t = i / sr;
    const env = Math.exp(-t * 26);
    const noise = (rng.next() * 2 - 1) * 0.8;
    const body = Math.sin(2 * Math.PI * 180 * t) * 0.4;
    const v = (noise + body) * env * gain;
    const idx = atFrame + i;
    if (idx < pcmFrames(dest)) dest.data[idx] += v;
  }
}

/**
 * Compose a deterministic music bed.
 * @param {object} spec
 * @param {string} [spec.seed='music']
 * @param {number} spec.seconds
 * @param {number} [spec.sampleRate=22050]
 * @param {string} [spec.mood='uplifting']
 * @param {number} [spec.tempo]  BPM override.
 * @param {number} [spec.gain=0.85]
 */
export function composeMusic(spec) {
  const sampleRate = spec.sampleRate || 22050;
  const seconds = spec.seconds;
  const mood = MOODS[spec.mood] || MOODS.uplifting;
  const rng = createRng(spec.seed || 'music');
  const tempo = spec.tempo || mood.tempo;
  const beat = 60 / tempo;
  const barBeats = 4;
  const frames = Math.round(seconds * sampleRate);
  const out = createPcm(sampleRate, 1, frames);
  const scale = SCALES[mood.scale];
  const root = 45 + rng.int(0, 3); // A2..C3 area
  const progression = mood.progression;

  const totalBeats = Math.floor(seconds / beat);
  const totalBars = Math.ceil(totalBeats / barBeats);

  for (let bar = 0; bar < totalBars; bar++) {
    const chordDegree = progression[bar % progression.length];
    const barStartFrame = Math.round(bar * barBeats * beat * sampleRate);

    // Bass — root on beats 1 and 3.
    for (const b of [0, 2]) {
      const at = barStartFrame + Math.round(b * beat * sampleRate);
      const midi = scaleNote(scale, root - 12, chordDegree);
      const dur = Math.round(beat * 0.9 * sampleRate);
      for (let i = 0; i < dur; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 3.2);
        const v = (Math.sin(2 * Math.PI * noteFreq(midi) * t) * 0.7 +
          Math.sin(2 * Math.PI * noteFreq(midi) * 2 * t) * 0.2) * env * 0.32;
        const idx = at + i;
        if (idx < frames) out.data[idx] += v;
      }
    }

    // Pad — triad held across the bar.
    const triad = [0, 2, 4];
    const padDur = Math.round(barBeats * beat * sampleRate);
    for (let i = 0; i < padDur; i++) {
      const t = i / sampleRate;
      const env = adsr(t, padDur / sampleRate, { attack: 0.25, decay: 0.3, sustain: 0.6, release: 0.4 });
      let s = 0;
      for (const d of triad) {
        const midi = scaleNote(scale, root, chordDegree + d);
        s += Math.sin(2 * Math.PI * noteFreq(midi) * t) * 0.33;
      }
      const idx = barStartFrame + i;
      if (idx < frames) out.data[idx] += s * env * 0.12 * mood.brightness;
    }

    // Melody — eighth notes with rests, on the scale.
    const steps = barBeats * 2;
    let degree = chordDegree + 7;
    for (let s = 0; s < steps; s++) {
      if (rng.next() < 0.28) continue; // rest
      degree += rng.pick([-2, -1, 1, 1, 2, 3]);
      const midi = scaleNote(scale, root + 12, degree);
      const at = barStartFrame + Math.round((s * beat) / 2 * sampleRate);
      const dur = Math.round((beat / 2) * 0.85 * sampleRate);
      const freq = noteFreq(midi);
      for (let i = 0; i < dur; i++) {
        const t = i / sampleRate;
        const env = adsr(t, dur / sampleRate, { attack: 0.005, decay: 0.08, sustain: 0.5, release: 0.12 });
        const v = (Math.sin(2 * Math.PI * freq * t) + 0.3 * Math.sin(2 * Math.PI * freq * 2 * t)) * env * 0.16 * mood.brightness;
        const idx = at + i;
        if (idx < frames) out.data[idx] += v;
      }
    }

    // Drums.
    for (let b = 0; b < barBeats; b++) {
      const at = barStartFrame + Math.round(b * beat * sampleRate);
      if (b === 0 || b === 2) addKick(out, at, 0.5);
      if (b === 1 || b === 3) addSnare(out, at, 0.22, rng);
      addHat(out, at, 0.08, rng);
      addHat(out, at + Math.round(beat * 0.5 * sampleRate), 0.06, rng);
    }
  }

  // Gentle feedback delay for space.
  const delayFrames = Math.round(beat * 0.75 * sampleRate);
  const fb = 0.28;
  for (let f = delayFrames; f < frames; f++) {
    out.data[f] += out.data[f - delayFrames] * fb;
  }

  normalize(out, spec.gain === undefined ? 0.85 : spec.gain);
  applyFade(out, { inSec: 0.4, outSec: 1.2 });
  return out;
}

export function upmix(pcm, channels) {
  if (pcm.channels === channels) return clonePcm(pcm);
  const frames = pcmFrames(pcm);
  const data = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    const v = pcm.data[f * pcm.channels];
    for (let c = 0; c < channels; c++) data[f * channels + c] = v;
  }
  return { sampleRate: pcm.sampleRate, channels, data };
}
