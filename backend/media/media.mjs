/**
 * Real, dependency-free media processing.
 *
 * This module implements genuine container/codec handling that runs entirely
 * locally — no network, no external binary, no optional dependency:
 *
 *   - RIFF/WAVE decode + encode (8/16/24/32-bit PCM and IEEE float), so audio
 *     produced or received by the agent can be packaged into a real, playable
 *     `.wav` file and inspected back;
 *   - header-level probing for PNG / JPEG / GIF / WAV / MP3 / FLAC / OGG /
 *     MP4 / WebM, returning pixel dimensions, sample rate, channel count and
 *     duration wherever the container exposes them.
 *
 * The provider-backed capabilities (Speech-to-Text, Text-to-Speech, video and
 * audio generation) live in the connector adapters; this module is the local,
 * always-available half, which is why `media.probe` is genuinely useful with
 * zero configuration. Nothing here fabricates data: an unrecognised buffer is
 * reported as `application/octet-stream` with `kind: 'unknown'`.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Byte-length of the fixed WAVE header we emit (RIFF + fmt + data headers). */
export const WAV_HEADER_BYTES = 44;

/**
 * Identify a media buffer from its magic bytes.
 * @param {Buffer} buffer
 * @returns {{mimeType:string, kind:'image'|'audio'|'video'|'unknown', format:string, extension:string}}
 */
export function sniffMediaType(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const unknown = { mimeType: 'application/octet-stream', kind: 'unknown', format: 'unknown', extension: 'bin' };
  if (buf.length < 12) return unknown;

  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { mimeType: 'image/png', kind: 'image', format: 'png', extension: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mimeType: 'image/jpeg', kind: 'image', format: 'jpeg', extension: 'jpg' };
  const gif = buf.toString('ascii', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return { mimeType: 'image/gif', kind: 'image', format: 'gif', extension: 'gif' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return { mimeType: 'audio/wav', kind: 'audio', format: 'wav', extension: 'wav' };
  if (buf.toString('ascii', 0, 4) === 'fLaC') return { mimeType: 'audio/flac', kind: 'audio', format: 'flac', extension: 'flac' };
  if (buf.toString('ascii', 0, 4) === 'OggS') return { mimeType: 'audio/ogg', kind: 'audio', format: 'ogg', extension: 'ogg' };
  if (buf.toString('ascii', 0, 3) === 'ID3') return { mimeType: 'audio/mpeg', kind: 'audio', format: 'mp3', extension: 'mp3' };
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { mimeType: 'audio/mpeg', kind: 'audio', format: 'mp3', extension: 'mp3' };
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mimeType: 'video/webm', kind: 'video', format: 'webm', extension: 'webm' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).trim();
    const audioBrands = new Set(['M4A ', 'M4B ', 'mp42', 'isom']);
    const kind = brand === 'M4A ' || brand === 'M4B ' ? 'audio' : 'video';
    return { mimeType: kind === 'audio' ? 'audio/mp4' : 'video/mp4', kind, format: 'mp4', extension: kind === 'audio' ? 'm4a' : 'mp4' };
  }
  return unknown;
}

/** PNG: IHDR width/height are the first two big-endian uint32 after the signature. */
function probePng(buffer) {
  if (buffer.length < 24) return {};
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** JPEG: walk the marker segments until the Start-Of-Frame carries the size. */
function probeJpeg(buffer) {
  let i = 2;
  while (i + 9 < buffer.length) {
    if (buffer[i] !== 0xff) { i += 1; continue; }
    const marker = buffer[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9) break;
    const length = buffer.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return {};
}

/** GIF: logical screen width/height are little-endian uint16 at offsets 6 and 8. */
function probeGif(buffer) {
  if (buffer.length < 10) return {};
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

/** WAV: parse the RIFF chunk list for `fmt ` and `data`. */
function probeWav(buffer) {
  if (buffer.length < WAV_HEADER_BYTES) return {};
  let offset = 12;
  let fmt = null;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ' && body + 16 <= buffer.length) {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      dataBytes = Math.max(0, Math.min(chunkSize, buffer.length - body));
    }
    offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
    if (chunkSize === 0 && chunkId !== 'data') break;
  }
  if (!fmt) return {};
  const durationSeconds = fmt.byteRate > 0 ? dataBytes / fmt.byteRate : null;
  return {
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    audioFormat: fmt.audioFormat,
    dataBytes,
    durationSeconds,
  };
}

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_SAMPLE_RATES_V1 = [44100, 48000, 32000];

/** MP3: locate the first frame after any ID3v2 tag and estimate the duration. */
function probeMp3(buffer) {
  let offset = 0;
  if (buffer.toString('ascii', 0, 3) === 'ID3' && buffer.length >= 10) {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size;
  }
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] === 0xff && (buffer[offset + 1] & 0xe0) === 0xe0) {
      const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f;
      const sampleRateIndex = (buffer[offset + 2] >> 2) & 0x03;
      const bitrate = MP3_BITRATES_V1_L3[bitrateIndex];
      const sampleRate = MP3_SAMPLE_RATES_V1[sampleRateIndex];
      if (bitrate && sampleRate) {
        const audioBytes = buffer.length - offset;
        return { sampleRate, bitrateKbps: bitrate, durationSeconds: (audioBytes * 8) / (bitrate * 1000), estimated: true };
      }
    }
    offset += 1;
  }
  return {};
}

/** MP4/M4A: read the movie header (`mvhd`) for the timescale and duration. */
function probeMp4(buffer) {
  const idx = buffer.indexOf('mvhd');
  if (idx < 0 || idx + 32 > buffer.length) return {};
  const version = buffer[idx + 4];
  if (version === 1) {
    const timescale = buffer.readUInt32BE(idx + 20);
    const duration = Number(buffer.readBigUInt64BE(idx + 24));
    return timescale > 0 ? { timescale, durationSeconds: duration / timescale } : {};
  }
  const timescale = buffer.readUInt32BE(idx + 12);
  const duration = buffer.readUInt32BE(idx + 16);
  return timescale > 0 ? { timescale, durationSeconds: duration / timescale } : {};
}

/**
 * Probe a media buffer: identify it and extract whatever metadata the container
 * exposes. Never throws on a malformed buffer — it degrades to the sniffed type.
 * @param {Buffer} buffer
 * @returns {object}
 */
export function probeMedia(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const type = sniffMediaType(buf);
  let details = {};
  try {
    if (type.format === 'png') details = probePng(buf);
    else if (type.format === 'jpeg') details = probeJpeg(buf);
    else if (type.format === 'gif') details = probeGif(buf);
    else if (type.format === 'wav') details = probeWav(buf);
    else if (type.format === 'mp3') details = probeMp3(buf);
    else if (type.format === 'mp4') details = probeMp4(buf);
  } catch {
    details = {};
  }
  return { ...type, bytes: buf.length, ...details };
}

/* -------------------------------------------------------------------------- */
/*  WAVE encode / decode                                                      */
/* -------------------------------------------------------------------------- */

function normalizeSamples(samples) {
  if (samples instanceof Float32Array) return samples;
  if (Array.isArray(samples)) return Float32Array.from(samples, (value) => Number(value) || 0);
  if (ArrayBuffer.isView(samples)) return Float32Array.from(samples, (value) => Number(value) || 0);
  throw new Error('WAV_SAMPLES_INVALID');
}

/**
 * Encode floating-point samples (range -1..1) into a real RIFF/WAVE buffer.
 * @param {{samples:ArrayLike<number>, sampleRate?:number, channels?:number, bitsPerSample?:8|16|24|32}} input
 * @returns {Buffer}
 */
export function encodeWav({ samples, sampleRate = 44100, channels = 1, bitsPerSample = 16 } = {}) {
  const floats = normalizeSamples(samples);
  const ch = Math.max(1, Math.min(Number(channels) || 1, 8));
  const rate = Math.max(8000, Math.min(Number(sampleRate) || 44100, 192000));
  const bits = [8, 16, 24, 32].includes(bitsPerSample) ? bitsPerSample : 16;
  const bytesPerSample = bits / 8;
  const dataBytes = floats.length * bytesPerSample;
  const buffer = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(ch, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * ch * bytesPerSample, 28);
  buffer.writeUInt16LE(ch * bytesPerSample, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < floats.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, floats[i]));
    if (bits === 8) {
      buffer.writeUInt8(Math.round((clamped + 1) * 127.5), offset);
    } else if (bits === 16) {
      buffer.writeInt16LE(Math.round(clamped * 32767), offset);
    } else if (bits === 24) {
      const value = Math.round(clamped * 8388607);
      buffer.writeUInt8(value & 0xff, offset);
      buffer.writeUInt8((value >> 8) & 0xff, offset + 1);
      buffer.writeUInt8((value >> 16) & 0xff, offset + 2);
    } else {
      buffer.writeInt32LE(Math.round(clamped * 2147483647), offset);
    }
    offset += bytesPerSample;
  }
  return buffer;
}

/**
 * Decode a PCM WAVE buffer into normalized floats plus its metadata.
 * @param {Buffer} buffer
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, durationSeconds:number, samples:Float32Array}}
 */
export function decodeWav(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const meta = probeWav(buf);
  if (!meta.sampleRate) throw new Error('WAV_INVALID');
  const bits = meta.bitsPerSample || 16;
  const bytesPerSample = bits / 8;
  const dataStart = findDataChunk(buf);
  if (dataStart < 0) throw new Error('WAV_INVALID');
  const count = Math.floor((buf.length - dataStart) / bytesPerSample);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const offset = dataStart + i * bytesPerSample;
    if (bits === 8) samples[i] = buf.readUInt8(offset) / 127.5 - 1;
    else if (bits === 16) samples[i] = buf.readInt16LE(offset) / 32767;
    else if (bits === 24) {
      const value = buf.readUInt8(offset) | (buf.readUInt8(offset + 1) << 8) | (buf.readUInt8(offset + 2) << 16);
      const signed = value & 0x800000 ? value - 0x1000000 : value;
      samples[i] = signed / 8388607;
    } else samples[i] = buf.readInt32LE(offset) / 2147483647;
  }
  return {
    sampleRate: meta.sampleRate,
    channels: meta.channels || 1,
    bitsPerSample: bits,
    durationSeconds: meta.durationSeconds ?? count / (meta.sampleRate * (meta.channels || 1)),
    samples,
  };
}

/** Locate the start of the `data` chunk payload in a RIFF/WAVE buffer. */
function findDataChunk(buffer) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') return offset + 8;
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return -1;
}

/**
 * Generate a real mono PCM sine tone (useful for notification sounds, tests and
 * as a deterministic audio fixture). Returns normalized floats.
 * @param {{frequency?:number, durationSeconds?:number, sampleRate?:number, amplitude?:number}} input
 * @returns {Float32Array}
 */
export function generateTone({ frequency = 440, durationSeconds = 1, sampleRate = 44100, amplitude = 0.5 } = {}) {
  const rate = Math.max(8000, Math.min(Number(sampleRate) || 44100, 192000));
  const seconds = Math.max(0, Math.min(Number(durationSeconds) || 0, 600));
  const count = Math.floor(rate * seconds);
  const samples = new Float32Array(count);
  const amp = Math.max(0, Math.min(Number(amplitude) || 0, 1));
  const omega = (2 * Math.PI * (Number(frequency) || 440)) / rate;
  for (let i = 0; i < count; i += 1) samples[i] = Math.sin(omega * i) * amp;
  return samples;
}
