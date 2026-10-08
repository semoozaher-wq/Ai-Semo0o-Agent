// AVI (RIFF) writer — dependency-free (Node built-ins only).
//
// Pairs with the baseline JPEG encoder to produce real, seekable MJPEG video
// with interleaved 16-bit PCM audio. This is a standards-compliant RIFF/AVI
// file: hdrl (avih + two strl), movi (interleaved 00dc/01wb chunks) and a
// complete idx1 index, so it opens and seeks correctly in VLC, ffplay, Windows
// Media Player and browsers that support MJPEG AVI.

function fourcc(s) {
  return Buffer.from(s, 'latin1');
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff, 0);
  return b;
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

function i16(v) {
  const b = Buffer.alloc(2);
  b.writeInt16LE(v | 0, 0);
  return b;
}

function chunk(id, data) {
  const pad = data.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([fourcc(id), u32(data.length), data, pad]);
}

function list(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([fourcc('LIST'), u32(body.length + 4), fourcc(type), body]);
}

/**
 * Encode an AVI file.
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {number} [spec.fps=12]
 * @param {Buffer[]} spec.frames  JPEG-encoded frames.
 * @param {{sampleRate:number, channels:number, data:Buffer}} [spec.audio]  16-bit LE PCM.
 * @returns {Buffer}
 */
export function encodeAvi(spec) {
  const { width, height, frames } = spec;
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('encodeAvi: at least one video frame is required');
  }
  const fps = spec.fps || 12;
  const audio = spec.audio || null;
  const microSecPerFrame = Math.round(1e6 / fps);
  const totalFrames = frames.length;
  const maxFrameBytes = frames.reduce((m, f) => Math.max(m, f.length), 0);

  // ---- interleave movi chunks ----
  const moviParts = [];
  const indexEntries = [];
  // offset is measured from the 'movi' FourCC (which sits at offset 0 of the list body).
  let moviOffset = 4;

  const audioBlockAlign = audio ? audio.channels * 2 : 0;
  const audioTotalSamples = audio ? Math.floor(audio.data.length / audioBlockAlign) : 0;

  for (let i = 0; i < totalFrames; i++) {
    const vchunk = chunk('00dc', frames[i]);
    indexEntries.push({ id: '00dc', flags: 0x10, offset: moviOffset, size: frames[i].length });
    moviParts.push(vchunk);
    moviOffset += vchunk.length;

    if (audio) {
      const start = Math.floor((i * audioTotalSamples) / totalFrames);
      const end = Math.floor(((i + 1) * audioTotalSamples) / totalFrames);
      if (end > start) {
        const slice = audio.data.subarray(start * audioBlockAlign, end * audioBlockAlign);
        const achunk = chunk('01wb', slice);
        indexEntries.push({ id: '01wb', flags: 0, offset: moviOffset, size: slice.length });
        moviParts.push(achunk);
        moviOffset += achunk.length;
      }
    }
  }
  const movi = list('movi', ...moviParts);

  // ---- hdrl ----
  const avih = Buffer.concat([
    u32(microSecPerFrame),
    u32(maxFrameBytes * fps),
    u32(0),
    u32(0x10 | 0x100), // AVIF_HASINDEX | AVIF_ISINTERLEAVED
    u32(totalFrames),
    u32(0),
    u32(audio ? 2 : 1),
    u32(maxFrameBytes),
    u32(width),
    u32(height),
    Buffer.alloc(16),
  ]);

  const videoStrh = Buffer.concat([
    fourcc('vids'),
    fourcc('MJPG'),
    u32(0),
    u16(0),
    u16(0),
    u32(0),
    u32(1), // dwScale
    u32(fps), // dwRate
    u32(0),
    u32(totalFrames),
    u32(maxFrameBytes),
    u32(0xffffffff), // quality
    u32(0), // sample size
    i16(0), i16(0), i16(width), i16(height),
  ]);

  const videoStrf = Buffer.concat([
    u32(40),
    u32(width),
    u32(height),
    u16(1),
    u16(24),
    fourcc('MJPG'),
    u32(width * height * 3),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  ]);

  const strlVideo = list('strl', chunk('strh', videoStrh), chunk('strf', videoStrf));

  let strlAudio = Buffer.alloc(0);
  if (audio) {
    const avgBytes = audio.sampleRate * audioBlockAlign;
    const audioStrh = Buffer.concat([
      fourcc('auds'),
      u32(0),
      u32(0),
      u16(0),
      u16(0),
      u32(0),
      u32(audioBlockAlign), // dwScale
      u32(audio.sampleRate), // dwRate
      u32(0),
      u32(audioTotalSamples),
      u32(avgBytes),
      u32(0xffffffff),
      u32(audioBlockAlign),
      i16(0), i16(0), i16(0), i16(0),
    ]);
    const audioStrf = Buffer.concat([
      u16(1), // PCM
      u16(audio.channels),
      u32(audio.sampleRate),
      u32(avgBytes),
      u16(audioBlockAlign),
      u16(16),
      u16(0),
    ]);
    strlAudio = list('strl', chunk('strh', audioStrh), chunk('strf', audioStrf));
  }

  const hdrl = list('hdrl', chunk('avih', avih), strlVideo, strlAudio);

  // ---- idx1 ----
  const idxParts = [];
  for (const e of indexEntries) {
    idxParts.push(fourcc(e.id), u32(e.flags), u32(e.offset), u32(e.size));
  }
  const idx1 = chunk('idx1', Buffer.concat(idxParts));

  // ---- RIFF ----
  const body = Buffer.concat([fourcc('AVI '), hdrl, movi, idx1]);
  const riff = Buffer.concat([fourcc('RIFF'), u32(body.length), body]);
  return riff;
}

/**
 * Structurally parse an AVI file (no pixel decoding).
 * @returns {{width:number,height:number,totalFrames:number,streams:number,indexEntries:number,hasAudio:boolean}}
 */
export function parseAvi(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'AVI ') {
    throw new Error('parseAvi: not an AVI/RIFF file');
  }
  let width = 0;
  let height = 0;
  let totalFrames = 0;
  let streams = 0;
  let hasAudio = false;
  let indexEntries = 0;

  const walk = (start, end) => {
    let pos = start;
    while (pos + 8 <= end) {
      const id = buf.toString('latin1', pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      const dataStart = pos + 8;
      if (id === 'LIST') {
        const type = buf.toString('latin1', dataStart, dataStart + 4);
        if (type === 'hdrl' || type === 'strl' || type === 'movi') {
          walk(dataStart + 4, dataStart + size);
        }
      } else if (id === 'avih') {
        width = buf.readUInt32LE(dataStart + 32);
        height = buf.readUInt32LE(dataStart + 36);
        totalFrames = buf.readUInt32LE(dataStart + 16);
        streams = buf.readUInt32LE(dataStart + 24);
      } else if (id === 'strh') {
        const fccType = buf.toString('latin1', dataStart, dataStart + 4);
        if (fccType === 'auds') hasAudio = true;
      } else if (id === 'idx1') {
        indexEntries = size / 16;
      }
      pos = dataStart + size + (size & 1);
    }
  };
  walk(12, buf.length);
  return { width, height, totalFrames, streams, indexEntries, hasAudio };
}
