// Animated GIF89a encoder — dependency-free (Node built-ins only).
//
// The Creation Kernel needs to emit real, playable animated images without
// ffmpeg or native modules. This module implements:
//   * median-cut colour quantisation (global or per-frame palettes),
//   * nearest-colour mapping with an exact memo cache + optional Floyd–Steinberg
//     dithering,
//   * the GIF variable-width LZW compressor,
//   * the full GIF89a container (logical screen descriptor, global colour table,
//     NETSCAPE2.0 loop extension, per-frame graphic control + image descriptor).
//
// Everything is deterministic: identical inputs always produce identical bytes.

const MAX_CODE = 4096;

// ---------------------------------------------------------------------------
// Colour utilities
// ---------------------------------------------------------------------------

function packRgb(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// ---------------------------------------------------------------------------
// Median-cut quantisation
// ---------------------------------------------------------------------------

function makeBox(colors) {
  let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
  let rs = 0, gs = 0, bs = 0;
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    const r = c[0], g = c[1], b = c[2];
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    rs += r; gs += g; bs += b;
  }
  return {
    colors,
    count: colors.length,
    range: [rMax - rMin, gMax - gMin, bMax - bMin],
    sum: [rs, gs, bs],
  };
}

function averageBox(box) {
  const n = box.count || 1;
  return [
    Math.round(box.sum[0] / n),
    Math.round(box.sum[1] / n),
    Math.round(box.sum[2] / n),
  ];
}

/**
 * Median-cut colour quantisation.
 * @param {Array<[number,number,number]>|Uint8Array} input  list of RGB triples
 *        (array of arrays) or a flat RGB byte array.
 * @param {number} maxColors  target palette size (2..256).
 * @returns {Array<[number,number,number]>} palette
 */
export function medianCut(input, maxColors = 256) {
  const colors = [];
  if (input.length && Array.isArray(input[0])) {
    for (let i = 0; i < input.length; i++) {
      const c = input[i];
      colors.push([c[0] & 255, c[1] & 255, c[2] & 255]);
    }
  } else {
    for (let i = 0; i + 2 < input.length; i += 3) {
      colors.push([input[i] & 255, input[i + 1] & 255, input[i + 2] & 255]);
    }
  }
  if (colors.length === 0) return [[0, 0, 0]];
  const target = Math.max(1, Math.min(256, maxColors | 0));
  let boxes = [makeBox(colors)];
  while (boxes.length < target) {
    let idx = -1;
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.count <= 1) continue;
      const v = Math.max(box.range[0], box.range[1], box.range[2]);
      if (v > best) { best = v; idx = i; }
    }
    if (idx === -1) break;
    const box = boxes[idx];
    let ch = 0;
    if (box.range[1] > box.range[ch]) ch = 1;
    if (box.range[2] > box.range[ch]) ch = 2;
    box.colors.sort((a, b) => a[ch] - b[ch]);
    const mid = box.colors.length >> 1;
    const left = box.colors.slice(0, mid);
    const right = box.colors.slice(mid);
    if (left.length === 0 || right.length === 0) break;
    boxes.splice(idx, 1, makeBox(left), makeBox(right));
  }
  return boxes.map(averageBox);
}

/**
 * Build a global palette by sampling pixels across every frame.
 * @param {Array<{data: Uint8Array}>} frames  RGBA frames.
 */
export function buildPaletteFromFrames(frames, maxColors = 256, options = {}) {
  const maxSamples = options.maxSamples || 65536;
  let total = 0;
  for (const f of frames) total += f.data.length >> 2;
  const stride = Math.max(1, Math.ceil(total / maxSamples));
  const samples = [];
  let counter = 0;
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) { counter++; continue; }
      if (counter % stride === 0) samples.push([d[i], d[i + 1], d[i + 2]]);
      counter++;
    }
  }
  if (samples.length === 0) return [[0, 0, 0]];
  return medianCut(samples, maxColors);
}

// ---------------------------------------------------------------------------
// Pixel → palette index mapping
// ---------------------------------------------------------------------------

/**
 * Build a coarse RGB→palette-index lookup table (bits per channel). Mapping a
 * whole frame through this is O(pixels) instead of O(pixels × palette), which
 * matters when rendering hundreds of frames.
 */
export function buildColorLut(palette, bits = 6) {
  const size = 1 << (bits * 3);
  const lut = new Uint8Array(size);
  const shift = 8 - bits;
  const half = 1 << (shift - 1);
  const n = palette.length;
  const rShift = bits * 2;
  const gShift = bits;
  for (let r = 0; r < (1 << bits); r++) {
    const R = (r << shift) + half;
    for (let g = 0; g < (1 << bits); g++) {
      const G = (g << shift) + half;
      const base = (r << rShift) | (g << gShift);
      for (let b = 0; b < (1 << bits); b++) {
        const B = (b << shift) + half;
        let best = 0;
        let bestD = Infinity;
        for (let p = 0; p < n; p++) {
          const c = palette[p];
          const dr = R - c[0], dg = G - c[1], db = B - c[2];
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) { bestD = d; best = p; if (d === 0) break; }
        }
        lut[base | b] = best;
      }
    }
  }
  return { lut, bits, shift, rShift, gShift };
}

/**
 * Map RGBA pixels onto a palette, returning one index byte per pixel.
 * Uses an exact memo cache; optionally applies Floyd–Steinberg dithering.
 * Pass `options.lut` (from buildColorLut) for a fast path on large frames.
 */
export function mapPixelsToPalette(rgba, palette, options = {}) {
  const n = palette.length;
  const dither = !!options.dither;
  const width = options.width || 0;
  const height = options.height || (width ? (rgba.length >> 2) / width : 0);
  const cache = new Map();
  const out = new Uint8Array(rgba.length >> 2);

  const nearest = (r, g, b) => {
    const key = packRgb(r, g, b);
    let idx = cache.get(key);
    if (idx !== undefined) return idx;
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < n; p++) {
      const c = palette[p];
      const dr = r - c[0], dg = g - c[1], db = b - c[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = p; if (d === 0) break; }
    }
    cache.set(key, best);
    return best;
  };

  if (!dither || !width) {
    const lut = options.lut;
    if (lut) {
      const { lut: table, shift, rShift, gShift } = lut;
      let o = 0;
      for (let i = 0; i < rgba.length; i += 4) {
        out[o++] = table[((rgba[i] >> shift) << rShift) | ((rgba[i + 1] >> shift) << gShift) | (rgba[i + 2] >> shift)];
      }
      return out;
    }
    let o = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      out[o++] = nearest(rgba[i], rgba[i + 1], rgba[i + 2]);
    }
    return out;
  }

  // Floyd–Steinberg error diffusion over a float working buffer.
  const buf = new Float32Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    buf[j] = rgba[i];
    buf[j + 1] = rgba[i + 1];
    buf[j + 2] = rgba[i + 2];
  }
  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const j = (y * width + x) * 3;
      const r = clamp255(buf[j]);
      const g = clamp255(buf[j + 1]);
      const b = clamp255(buf[j + 2]);
      const idx = nearest(Math.round(r), Math.round(g), Math.round(b));
      out[y * width + x] = idx;
      const c = palette[idx];
      const er = r - c[0], eg = g - c[1], eb = b - c[2];
      const spread = (dx, dy, factor) => {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
        const k = (ny * width + nx) * 3;
        buf[k] += er * factor;
        buf[k + 1] += eg * factor;
        buf[k + 2] += eb * factor;
      };
      spread(1, 0, 7 / 16);
      spread(-1, 1, 3 / 16);
      spread(0, 1, 5 / 16);
      spread(1, 1, 1 / 16);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LZW compressor (GIF variable-width codes)
// ---------------------------------------------------------------------------

/**
 * Compress a stream of palette indices with the GIF LZW variant.
 * @param {Uint8Array|number[]} indices
 * @param {number} minCodeSize  root code width (>= 2).
 * @returns {Uint8Array}
 */
export function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = [];
  let cur = 0;
  let curBits = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let dict = new Map();

  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };

  emit(clearCode);

  if (indices.length === 0) {
    emit(endCode);
    if (curBits > 0) out.push(cur & 0xff);
    return Uint8Array.from(out);
  }

  let prefix = indices[0] & 0xff;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i] & 0xff;
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode < MAX_CODE) {
      dict.set(key, nextCode);
      nextCode++;
      // GIF uses "late change". The encoder's dictionary runs exactly one entry
      // ahead of the decoder's, so we widen when nextCode passes (1<<codeSize)+1
      // to stay byte-aligned with a spec-compliant decoder.
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      dict = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(endCode);
  if (curBits > 0) out.push(cur & 0xff);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Container helpers
// ---------------------------------------------------------------------------

function encodeSubBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const len = Math.min(255, data.length - i);
    parts.push(Buffer.from([len]));
    parts.push(Buffer.from(data.subarray(i, i + len)));
  }
  parts.push(Buffer.from([0x00]));
  return Buffer.concat(parts);
}

function colorTableBytes(palette, size) {
  const table = Buffer.alloc(size * 3);
  for (let i = 0; i < size; i++) {
    const c = palette[i] || [0, 0, 0];
    table[i * 3] = c[0] & 255;
    table[i * 3 + 1] = c[1] & 255;
    table[i * 3 + 2] = c[2] & 255;
  }
  return table;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

/**
 * Encode an animated GIF89a.
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {Array<{data: Uint8Array, delayMs?: number, disposal?: number, palette?: Array<[number,number,number]>}>} spec.frames
 * @param {number} [spec.loop=0]  0 = infinite.
 * @param {Array<[number,number,number]>} [spec.palette]  global palette override.
 * @param {boolean} [spec.dither=false]
 * @param {number} [spec.background=0]
 * @returns {Buffer}
 */
export function encodeGif(spec) {
  const { width, height, frames } = spec;
  if (!width || !height) throw new Error('encodeGif: width and height are required');
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('encodeGif: at least one frame is required');
  }
  const loop = spec.loop === undefined ? 0 : spec.loop;
  const dither = !!spec.dither;
  const globalPalette = spec.palette || buildPaletteFromFrames(frames, 256);
  const globalSize = nextPowerOfTwo(Math.max(2, Math.min(256, globalPalette.length)));
  const gctBits = Math.round(Math.log2(globalSize)) - 1;

  const chunks = [];
  chunks.push(Buffer.from('GIF89a', 'latin1'));

  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0xf0 | (gctBits & 0x07); // GCT present, 8-bit colour resolution
  lsd[5] = spec.background & 0xff;
  lsd[6] = 0;
  chunks.push(lsd);
  chunks.push(colorTableBytes(globalPalette, globalSize));

  if (loop >= 0) {
    const app = Buffer.alloc(19);
    app[0] = 0x21;
    app[1] = 0xff;
    app[2] = 0x0b;
    Buffer.from('NETSCAPE2.0', 'latin1').copy(app, 3);
    app[14] = 0x03;
    app[15] = 0x01;
    app.writeUInt16LE(loop & 0xffff, 16);
    app[18] = 0x00;
    chunks.push(app);
  }

  const minCodeSize = Math.max(2, Math.round(Math.log2(globalSize)));
  const lut = dither ? null : buildColorLut(globalPalette, spec.lutBits || 6);

  for (const frame of frames) {
    const delay = Math.max(0, Math.round((frame.delayMs === undefined ? 100 : frame.delayMs) / 10));
    const indices = mapPixelsToPalette(frame.data, globalPalette, {
      dither,
      width,
      height,
      lut,
    });

    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    gce[3] = ((frame.disposal === undefined ? 1 : frame.disposal) & 0x07) << 2;
    gce.writeUInt16LE(delay, 4);
    gce[6] = 0;
    gce[7] = 0x00;
    chunks.push(gce);

    const id = Buffer.alloc(10);
    id[0] = 0x2c;
    id.writeUInt16LE(0, 1);
    id.writeUInt16LE(0, 3);
    id.writeUInt16LE(width, 5);
    id.writeUInt16LE(height, 7);
    id[9] = 0x00;
    chunks.push(id);

    chunks.push(Buffer.from([minCodeSize]));
    chunks.push(encodeSubBlocks(lzwEncode(indices, minCodeSize)));
  }

  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Structural parser (used by tests / probes)
// ---------------------------------------------------------------------------

/**
 * Parse the structural skeleton of a GIF without decoding pixels.
 * @returns {{width:number,height:number,frames:number,loop:number|null,version:string,globalPaletteSize:number}}
 */
export function parseGif(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const sig = buf.toString('latin1', 0, 6);
  if (sig !== 'GIF89a' && sig !== 'GIF87a') throw new Error('parseGif: not a GIF');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 1 << ((packed & 0x07) + 1) : 0;
  let pos = 13;
  if (hasGct) pos += gctSize * 3;

  let frames = 0;
  let loop = null;
  const skipSubBlocks = () => {
    while (pos < buf.length) {
      const len = buf[pos++];
      if (len === 0) break;
      pos += len;
    }
  };

  while (pos < buf.length) {
    const block = buf[pos++];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      const label = buf[pos++];
      if (label === 0xff) {
        const size = buf[pos++];
        const appId = buf.toString('latin1', pos, pos + 11);
        pos += size;
        // sub-blocks
        let sub = pos;
        while (sub < buf.length) {
          const len = buf[sub++];
          if (len === 0) break;
          if (appId === 'NETSCAPE2.0' && len >= 3 && buf[sub] === 0x01) {
            loop = buf.readUInt16LE(sub + 1);
          }
          sub += len;
        }
        pos = sub;
      } else {
        skipSubBlocks();
      }
    } else if (block === 0x2c) {
      frames++;
      const ipacked = buf[pos + 8];
      pos += 9;
      const hasLct = (ipacked & 0x80) !== 0;
      const lctSize = hasLct ? 1 << ((ipacked & 0x07) + 1) : 0;
      if (hasLct) pos += lctSize * 3;
      pos++; // min code size
      skipSubBlocks();
    } else {
      break;
    }
  }
  return { width, height, frames, loop, version: sig, globalPaletteSize: gctSize };
}
