/**
 * Real PNG encode/decode, dependency-free (only `node:zlib`).
 *
 * Why a hand-written PNG codec? The Creation Kernel must be able to *read* an
 * image a provider returned (to composite, letterbox, colour-match or analyse it)
 * and *write* a lossless frame for the storyboard/contact-sheet and for the
 * deterministic Local Studio — all without ffmpeg, sharp, canvas or any native
 * dependency. PNG is the one format that is both lossless and trivial to emit
 * correctly, so it is the kernel's canonical still-image format.
 *
 * Encoder: RGBA8 -> adaptive per-scanline filtering (the standard minimum-sum-of-
 * absolute-differences heuristic over None/Sub/Up/Average/Paeth) -> zlib deflate
 * -> IHDR/IDAT/IEND with CRC-32. The output is a spec-compliant PNG that any
 * decoder (including this one) reads back byte-for-byte.
 *
 * Decoder: parses the chunk stream, inflates IDAT, reverses the per-scanline
 * filters and normalises to RGBA8. Supports colour types 0/2/3/4/6 at bit depth
 * 8 and 16 (16-bit is downsampled to 8) and expands tRNS transparency, so an
 * arbitrary PNG a provider returns can be composited.
 */

import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 as required by the PNG spec. */
export function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Encode an RGBA8 image into a PNG buffer.
 * @param {{width:number, height:number, data:Uint8Array|Buffer, filter?:boolean}} image
 * @returns {Buffer}
 */
export function encodePng({ width, height, data, filter = true } = {}) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const rgba = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  if (rgba.length < w * h * 4) throw new Error('PNG_PIXELS_TOO_SHORT');

  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const prior = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);

  for (let y = 0; y < h; y += 1) {
    const src = y * stride;
    let filterType = 0;
    let best = null;
    if (filter) {
      // Evaluate all five filters and keep the one with the smallest sum of
      // absolute (signed) residuals — the classic libpng heuristic.
      for (let type = 0; type < 5; type += 1) {
        let score = 0;
        for (let x = 0; x < stride; x += 1) {
          const rawByte = rgba[src + x];
          const left = x >= 4 ? rgba[src + x - 4] : 0;
          const up = prior[x];
          const upLeft = x >= 4 ? prior[x - 4] : 0;
          let value;
          if (type === 0) value = rawByte;
          else if (type === 1) value = rawByte - left;
          else if (type === 2) value = rawByte - up;
          else if (type === 3) value = rawByte - ((left + up) >> 1);
          else value = rawByte - paeth(left, up, upLeft);
          line[x] = value & 0xff;
          score += Math.abs((value << 24) >> 24);
        }
        if (best === null || score < best) { best = score; filterType = type; }
      }
      for (let x = 0; x < stride; x += 1) {
        const rawByte = rgba[src + x];
        const left = x >= 4 ? rgba[src + x - 4] : 0;
        const up = prior[x];
        const upLeft = x >= 4 ? prior[x - 4] : 0;
        let value;
        if (filterType === 0) value = rawByte;
        else if (filterType === 1) value = rawByte - left;
        else if (filterType === 2) value = rawByte - up;
        else if (filterType === 3) value = rawByte - ((left + up) >> 1);
        else value = rawByte - paeth(left, up, upLeft);
        line[x] = value & 0xff;
      }
    } else {
      rgba.copy(line, 0, src, src + stride);
    }
    raw[y * (stride + 1)] = filterType;
    line.copy(raw, y * (stride + 1) + 1);
    // The predictor for the NEXT row uses the ORIGINAL pixels of this row, not
    // the filtered residuals we just emitted.
    rgba.copy(prior, 0, src, src + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function unfilter(raw, width, height, bytesPerPixel, stride) {
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[pos];
    pos += 1;
    const rowStart = y * stride;
    const priorStart = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= bytesPerPixel ? out[rowStart + x - bytesPerPixel] : 0;
      const up = y > 0 ? out[priorStart + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? out[priorStart + x - bytesPerPixel] : 0;
      let result;
      if (filterType === 0) result = value;
      else if (filterType === 1) result = value + left;
      else if (filterType === 2) result = value + up;
      else if (filterType === 3) result = value + ((left + up) >> 1);
      else if (filterType === 4) result = value + paeth(left, up, upLeft);
      else throw new Error(`PNG_FILTER_UNSUPPORTED:${filterType}`);
      out[rowStart + x] = result & 0xff;
    }
    pos += stride;
  }
  return out;
}

function readChunks(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('PNG_SIGNATURE_INVALID');
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    chunks.push({ type, data: buffer.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

/**
 * Decode a PNG buffer into RGBA8.
 * @param {Buffer} buffer
 * @returns {{width:number, height:number, data:Buffer}}
 */
export function decodePng(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('PNG_IHDR_MISSING');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (interlace !== 0) throw new Error('PNG_INTERLACE_UNSUPPORTED');
  if (![8, 16].includes(bitDepth)) throw new Error(`PNG_BIT_DEPTH_UNSUPPORTED:${bitDepth}`);
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) throw new Error(`PNG_COLOR_TYPE_UNSUPPORTED:${colorType}`);

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);

  const sampleBytes = bitDepth / 8;
  const bytesPerPixel = channels * sampleBytes;
  const stride = width * bytesPerPixel;
  const pixels = unfilter(raw, width, height, bytesPerPixel, stride);

  // Palette + transparency.
  let palette = null;
  let trns = null;
  if (colorType === 3) {
    const plte = chunks.find((c) => c.type === 'PLTE');
    if (!plte) throw new Error('PNG_PLTE_MISSING');
    palette = plte.data;
    const trnsChunk = chunks.find((c) => c.type === 'tRNS');
    trns = trnsChunk ? trnsChunk.data : null;
  } else {
    const trnsChunk = chunks.find((c) => c.type === 'tRNS');
    trns = trnsChunk ? trnsChunk.data : null;
  }

  const out = Buffer.alloc(width * height * 4);
  const sample = (row, col, channel) => {
    const index = row * stride + (col * channels + channel) * sampleBytes;
    return bitDepth === 16 ? pixels[index] : pixels[index];
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = sample(y, x, 0); out[o + 1] = sample(y, x, 1); out[o + 2] = sample(y, x, 2); out[o + 3] = sample(y, x, 3);
      } else if (colorType === 2) {
        out[o] = sample(y, x, 0); out[o + 1] = sample(y, x, 1); out[o + 2] = sample(y, x, 2); out[o + 3] = 255;
        if (trns && trns.length >= 6) {
          const tr = trns.readUInt16BE(0); const tg = trns.readUInt16BE(2); const tb = trns.readUInt16BE(4);
          if (sample(y, x, 0) === (tr & 0xff) && sample(y, x, 1) === (tg & 0xff) && sample(y, x, 2) === (tb & 0xff)) out[o + 3] = 0;
        }
      } else if (colorType === 0) {
        const g = sample(y, x, 0);
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
        if (trns && trns.length >= 2) { const tg = trns.readUInt16BE(0); if (g === (tg & 0xff)) out[o + 3] = 0; }
      } else if (colorType === 4) {
        const g = sample(y, x, 0);
        out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = sample(y, x, 1);
      } else if (colorType === 3) {
        const index = sample(y, x, 0);
        const p = index * 3;
        out[o] = palette[p] ?? 0; out[o + 1] = palette[p + 1] ?? 0; out[o + 2] = palette[p + 2] ?? 0;
        out[o + 3] = trns && index < trns.length ? trns[index] : 255;
      }
    }
  }

  return { width, height, data: out };
}

/** Convenience: decode a PNG and return {width,height} only (cheap header read). */
export function pngDimensions(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
