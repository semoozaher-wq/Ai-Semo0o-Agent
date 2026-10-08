// Baseline JPEG encoder — dependency-free (Node built-ins only).
//
// Why this exists: the Creation Kernel must emit real, widely-decodable images
// and MJPEG video without ffmpeg or native modules. This is a complete baseline
// (sequential, Huffman) JPEG encoder: RGB → YCbCr, 8×8 forward DCT, Annex-K
// quantisation scaled by a quality knob, zig-zag scan and canonical Huffman
// coding with byte stuffing. Supports 4:4:4 and 4:2:0 chroma sampling and a
// grayscale mode. Output is a standard JFIF stream decodable everywhere.

// ---------------------------------------------------------------------------
// Standard tables (ITU-T T.81 / Annex K)
// ---------------------------------------------------------------------------

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

const QUANT_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

const QUANT_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51,
  0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1,
  0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18,
  0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
  0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57,
  0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92,
  0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8,
  0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2,
  0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07,
  0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09,
  0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25,
  0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
  0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
  0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74,
  0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba,
  0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
  0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2,
  0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

// ---------------------------------------------------------------------------
// Precomputed DCT basis
// ---------------------------------------------------------------------------

const DCT = new Float32Array(64);
for (let u = 0; u < 8; u++) {
  const cu = u === 0 ? Math.SQRT1_2 : 1;
  for (let x = 0; x < 8; x++) {
    DCT[u * 8 + x] = cu * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
}

const _tmp = new Float32Array(64);

function forwardDCT(block, out) {
  // block indexed [y*8+x]; out indexed [v*8+u]
  for (let y = 0; y < 8; y++) {
    const row = y * 8;
    for (let u = 0; u < 8; u++) {
      const base = u * 8;
      let s = 0;
      for (let x = 0; x < 8; x++) s += DCT[base + x] * block[row + x];
      _tmp[row + u] = s;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      const base = v * 8;
      let s = 0;
      for (let y = 0; y < 8; y++) s += DCT[base + y] * _tmp[y * 8 + u];
      out[v * 8 + u] = s * 0.25;
    }
  }
}

// ---------------------------------------------------------------------------
// Quality → quantisation tables
// ---------------------------------------------------------------------------

function scaleQuantTable(base, quality) {
  const q = Math.max(1, Math.min(100, quality));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    const v = Math.floor((base[i] * scale + 50) / 100);
    out[i] = Math.max(1, Math.min(255, v));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Huffman table construction
// ---------------------------------------------------------------------------

function buildHuffmanCodes(bits, vals) {
  const codes = new Array(256);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const count = bits[len - 1];
    for (let i = 0; i < count; i++) {
      codes[vals[k]] = { code, length: len };
      k++;
      code++;
    }
    code <<= 1;
  }
  return codes;
}

const DC_LUMA_CODES = buildHuffmanCodes(DC_LUMA_BITS, DC_LUMA_VALS);
const AC_LUMA_CODES = buildHuffmanCodes(AC_LUMA_BITS, AC_LUMA_VALS);
const DC_CHROMA_CODES = buildHuffmanCodes(DC_CHROMA_BITS, DC_CHROMA_VALS);
const AC_CHROMA_CODES = buildHuffmanCodes(AC_CHROMA_BITS, AC_CHROMA_VALS);

// ---------------------------------------------------------------------------
// Bit writer with JPEG byte stuffing
// ---------------------------------------------------------------------------

class BitWriter {
  constructor() {
    this.bytes = [];
    this.cur = 0;
    this.nbits = 0;
  }
  writeBits(value, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >> i) & 1);
      this.nbits++;
      if (this.nbits === 8) {
        this.bytes.push(this.cur & 0xff);
        if ((this.cur & 0xff) === 0xff) this.bytes.push(0x00);
        this.cur = 0;
        this.nbits = 0;
      }
    }
  }
  writeCode(code, length) {
    this.writeBits(code, length);
  }
  flush() {
    if (this.nbits > 0) {
      this.cur <<= 8 - this.nbits;
      this.bytes.push(this.cur & 0xff);
      if ((this.cur & 0xff) === 0xff) this.bytes.push(0x00);
      this.cur = 0;
      this.nbits = 0;
    }
  }
}

function bitLength(v) {
  let a = Math.abs(v);
  let n = 0;
  while (a) { n++; a >>= 1; }
  return n;
}

// ---------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------

function rgbToYCbCr(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
  const cr = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  return [y, cb, cr];
}

/**
 * Encode an RGBA buffer to a baseline JPEG.
 * @param {object} spec
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {Uint8Array} spec.data  RGBA pixels (length = width*height*4).
 * @param {number} [spec.quality=85]
 * @param {'444'|'420'} [spec.subsample='420']
 * @param {boolean} [spec.grayscale=false]
 * @returns {Buffer}
 */
export function encodeJpeg(spec) {
  const { width, height, data } = spec;
  if (!width || !height) throw new Error('encodeJpeg: width and height are required');
  const quality = spec.quality === undefined ? 85 : spec.quality;
  const grayscale = !!spec.grayscale;
  const subsample = grayscale ? '444' : (spec.subsample || '420');
  const hSamp = subsample === '420' ? 2 : 1;
  const vSamp = subsample === '420' ? 2 : 1;

  const mcuW = 8 * hSamp;
  const mcuH = 8 * vSamp;
  const paddedW = Math.ceil(width / mcuW) * mcuW;
  const paddedH = Math.ceil(height / mcuH) * mcuH;

  // --- build component planes ---
  const yPlane = new Uint8Array(paddedW * paddedH);
  const cw = paddedW / hSamp;
  const ch = paddedH / vSamp;
  const cbPlane = grayscale ? null : new Uint8Array(cw * ch);
  const crPlane = grayscale ? null : new Uint8Array(cw * ch);

  const clampXY = (x, y) => {
    const sx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const sy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return (sy * width + sx) * 4;
  };

  for (let y = 0; y < paddedH; y++) {
    for (let x = 0; x < paddedW; x++) {
      const o = clampXY(x, y);
      const [Y] = rgbToYCbCr(data[o], data[o + 1], data[o + 2]);
      yPlane[y * paddedW + x] = Y < 0 ? 0 : Y > 255 ? 255 : Math.round(Y);
    }
  }

  if (!grayscale) {
    for (let cy = 0; cy < ch; cy++) {
      for (let cx = 0; cx < cw; cx++) {
        let sb = 0, sr = 0, n = 0;
        for (let dy = 0; dy < vSamp; dy++) {
          for (let dx = 0; dx < hSamp; dx++) {
            const x = cx * hSamp + dx;
            const y = cy * vSamp + dy;
            const o = clampXY(x, y);
            const [, Cb, Cr] = rgbToYCbCr(data[o], data[o + 1], data[o + 2]);
            sb += Cb;
            sr += Cr;
            n++;
          }
        }
        const idx = cy * cw + cx;
        const cb = sb / n;
        const cr = sr / n;
        cbPlane[idx] = cb < 0 ? 0 : cb > 255 ? 255 : Math.round(cb);
        crPlane[idx] = cr < 0 ? 0 : cr > 255 ? 255 : Math.round(cr);
      }
    }
  }

  const qLuma = scaleQuantTable(QUANT_LUMA, quality);
  const qChroma = scaleQuantTable(QUANT_CHROMA, quality);

  const writer = new BitWriter();
  const dcPrev = [0, 0, 0];

  const quantized = new Int16Array(64);
  const coeff = new Float32Array(64);
  const blockBuf = new Float32Array(64);

  const emitBlock = (plane, planeW, bx, by, quant, dcCodes, acCodes, comp) => {
    for (let y = 0; y < 8; y++) {
      const row = (by + y) * planeW + bx;
      for (let x = 0; x < 8; x++) blockBuf[y * 8 + x] = plane[row + x] - 128;
    }
    forwardDCT(blockBuf, coeff);
    for (let i = 0; i < 64; i++) {
      quantized[i] = Math.round(coeff[i] / quant[i]);
    }
    // DC
    const dc = quantized[0];
    const diff = dc - dcPrev[comp];
    dcPrev[comp] = dc;
    const dcCat = bitLength(diff);
    const dcCode = dcCodes[dcCat];
    writer.writeCode(dcCode.code, dcCode.length);
    if (dcCat > 0) {
      const bits = diff >= 0 ? diff : diff + (1 << dcCat) - 1;
      writer.writeBits(bits, dcCat);
    }
    // AC
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = quantized[ZIGZAG[k]];
      if (v === 0) { run++; continue; }
      while (run > 15) {
        const zrl = acCodes[0xf0];
        writer.writeCode(zrl.code, zrl.length);
        run -= 16;
      }
      const cat = bitLength(v);
      const sym = (run << 4) | cat;
      const code = acCodes[sym];
      writer.writeCode(code.code, code.length);
      const bits = v >= 0 ? v : v + (1 << cat) - 1;
      writer.writeBits(bits, cat);
      run = 0;
    }
    if (run > 0) {
      const eob = acCodes[0x00];
      writer.writeCode(eob.code, eob.length);
    }
  };

  // --- scan MCUs ---
  const numComp = grayscale ? 1 : 3;
  for (let my = 0; my < paddedH; my += mcuH) {
    for (let mx = 0; mx < paddedW; mx += mcuW) {
      // Y blocks
      for (let by = 0; by < vSamp; by++) {
        for (let bx = 0; bx < hSamp; bx++) {
          emitBlock(yPlane, paddedW, mx + bx * 8, my + by * 8, qLuma, DC_LUMA_CODES, AC_LUMA_CODES, 0);
        }
      }
      if (!grayscale) {
        const cxb = (mx / hSamp);
        const cyb = (my / vSamp);
        emitBlock(cbPlane, cw, cxb, cyb, qChroma, DC_CHROMA_CODES, AC_CHROMA_CODES, 1);
        emitBlock(crPlane, cw, cxb, cyb, qChroma, DC_CHROMA_CODES, AC_CHROMA_CODES, 2);
      }
    }
  }
  writer.flush();

  // --- assemble segments ---
  const segments = [];
  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];

  // SOI
  segments.push(Buffer.from([0xff, 0xd8]));

  // APP0 JFIF
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  ]);
  segments.push(app0);

  // DQT (two tables)
  const dqt = [];
  dqt.push(0xff, 0xdb);
  const dqtLen = grayscale ? 2 + 1 + 64 : 2 + 1 + 64 + 1 + 64;
  dqt.push(...u16(dqtLen));
  dqt.push(0x00);
  for (let i = 0; i < 64; i++) dqt.push(qLuma[ZIGZAG[i]]);
  if (!grayscale) {
    dqt.push(0x01);
    for (let i = 0; i < 64; i++) dqt.push(qChroma[ZIGZAG[i]]);
  }
  segments.push(Buffer.from(dqt));

  // SOF0
  const sof = [];
  sof.push(0xff, 0xc0);
  sof.push(...u16(8 + 3 * numComp));
  sof.push(8);
  sof.push(...u16(height));
  sof.push(...u16(width));
  sof.push(numComp);
  if (grayscale) {
    sof.push(1, 0x11, 0);
  } else {
    sof.push(1, (hSamp << 4) | vSamp, 0);
    sof.push(2, 0x11, 1);
    sof.push(3, 0x11, 1);
  }
  segments.push(Buffer.from(sof));

  // DHT
  const dht = [];
  dht.push(0xff, 0xc4);
  const tmpHuff = [];
  const collect = (cls, id, bits, vals) => {
    tmpHuff.push((cls << 4) | id);
    for (let i = 0; i < 16; i++) tmpHuff.push(bits[i]);
    for (const v of vals) tmpHuff.push(v);
  };
  collect(0, 0, DC_LUMA_BITS, DC_LUMA_VALS);
  collect(1, 0, AC_LUMA_BITS, AC_LUMA_VALS);
  if (!grayscale) {
    collect(0, 1, DC_CHROMA_BITS, DC_CHROMA_VALS);
    collect(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS);
  }
  dht.push(...u16(2 + tmpHuff.length));
  dht.push(...tmpHuff);
  segments.push(Buffer.from(dht));

  // SOS
  const sos = [];
  sos.push(0xff, 0xda);
  sos.push(...u16(6 + 2 * numComp));
  sos.push(numComp);
  if (grayscale) {
    sos.push(1, 0x00);
  } else {
    sos.push(1, 0x00);
    sos.push(2, 0x11);
    sos.push(3, 0x11);
  }
  sos.push(0, 63, 0);
  segments.push(Buffer.from(sos));

  // entropy data
  segments.push(Buffer.from(writer.bytes));

  // EOI
  segments.push(Buffer.from([0xff, 0xd9]));

  return Buffer.concat(segments);
}

/**
 * Read the dimensions of a JPEG from its SOF marker.
 * @returns {{width:number,height:number,components:number}|null}
 */
export function jpegDimensions(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    if (marker === 0xd8 || marker === 0xd9) { pos += 2; continue; }
    const len = buf.readUInt16BE(pos + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: buf.readUInt16BE(pos + 5),
        width: buf.readUInt16BE(pos + 7),
        components: buf[pos + 9],
      };
    }
    pos += 2 + len;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Baseline JPEG decoder (sequential Huffman) — symmetric with the encoder.
// ---------------------------------------------------------------------------

function buildHuffDecoder(bits, vals) {
  const minCode = new Array(17).fill(0);
  const maxCode = new Array(17).fill(-1);
  const ptr = new Array(17).fill(0);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    const count = bits[len - 1];
    if (count > 0) {
      ptr[len] = k;
      minCode[len] = code;
      code += count;
      maxCode[len] = code - 1;
      k += count;
    }
    code <<= 1;
  }
  return { minCode, maxCode, ptr, vals };
}

class BitReader {
  constructor(data, pos) {
    this.data = data;
    this.pos = pos;
    this.buf = 0;
    this.count = 0;
    this.eof = false;
  }
  fill() {
    if (this.eof) return;
    let b = this.data[this.pos++];
    if (b === undefined) { this.eof = true; this.buf = 0; this.count = 8; return; }
    if (b === 0xff) {
      const next = this.data[this.pos];
      if (next === 0x00) this.pos++;
      else { this.eof = true; b = 0; }
    }
    this.buf = b;
    this.count = 8;
  }
  bit() {
    if (this.count === 0) this.fill();
    this.count--;
    return (this.buf >> this.count) & 1;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v;
  }
}

function decodeHuff(reader, table) {
  let code = 0;
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | reader.bit();
    if (table.maxCode[len] >= 0 && code <= table.maxCode[len]) {
      return table.vals[table.ptr[len] + code - table.minCode[len]];
    }
  }
  throw new Error('JPEG_DECODE_BAD_HUFFMAN');
}

function receiveExtend(reader, s) {
  if (s === 0) return 0;
  const v = reader.bits(s);
  if (v < 1 << (s - 1)) return v - (1 << s) + 1;
  return v;
}

const _idctTmp = new Float32Array(64);
function inverseDCT(coeff, out) {
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += DCT[u * 8 + x] * coeff[v * 8 + u];
      _idctTmp[v * 8 + x] = s;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += DCT[v * 8 + y] * _idctTmp[v * 8 + x];
      out[y * 8 + x] = s * 0.25 + 128;
    }
  }
}

/**
 * Decode a baseline (or extended sequential) JPEG into RGBA.
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width:number, height:number, data:Uint8Array}}
 */
export function decodeJpeg(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('JPEG_DECODE_NOT_JPEG');
  let pos = 2;
  const quant = {};
  const huffDC = {};
  const huffAC = {};
  let frame = null;
  let scan = null;

  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const marker = buf[pos + 1];
    pos += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;
    const len = buf.readUInt16BE(pos);
    const segStart = pos + 2;
    const segEnd = pos + len;

    if (marker === 0xdb) {
      let p = segStart;
      while (p < segEnd) {
        const pq = buf[p] >> 4;
        const tq = buf[p] & 15;
        p++;
        const table = new Uint16Array(64);
        for (let i = 0; i < 64; i++) {
          table[i] = pq ? buf.readUInt16BE(p) : buf[p];
          p += pq ? 2 : 1;
        }
        quant[tq] = table;
      }
    } else if (marker === 0xc4) {
      let p = segStart;
      while (p < segEnd) {
        const tc = buf[p] >> 4;
        const th = buf[p] & 15;
        p++;
        const bits = [];
        let total = 0;
        for (let i = 0; i < 16; i++) { bits.push(buf[p + i]); total += buf[p + i]; }
        p += 16;
        const vals = [];
        for (let i = 0; i < total; i++) vals.push(buf[p + i]);
        p += total;
        const dec = buildHuffDecoder(bits, vals);
        if (tc === 0) huffDC[th] = dec; else huffAC[th] = dec;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      const precision = buf[segStart];
      const height = buf.readUInt16BE(segStart + 1);
      const width = buf.readUInt16BE(segStart + 3);
      const nComp = buf[segStart + 5];
      const components = [];
      let p = segStart + 6;
      for (let i = 0; i < nComp; i++) {
        components.push({
          id: buf[p],
          h: buf[p + 1] >> 4,
          v: buf[p + 1] & 15,
          tq: buf[p + 2],
        });
        p += 3;
      }
      frame = { precision, width, height, components };
    } else if (marker === 0xda) {
      const nComp = buf[segStart];
      const comps = [];
      let p = segStart + 1;
      for (let i = 0; i < nComp; i++) {
        comps.push({ id: buf[p], dc: buf[p + 1] >> 4, ac: buf[p + 1] & 15 });
        p += 2;
      }
      scan = { comps, start: segEnd };
      break; // entropy data follows
    }
    pos = segEnd;
  }

  if (!frame || !scan) throw new Error('JPEG_DECODE_UNSUPPORTED');

  const { width, height, components } = frame;
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const mcuW = 8 * maxH;
  const mcuH = 8 * maxV;
  const mcuCols = Math.ceil(width / mcuW);
  const mcuRows = Math.ceil(height / mcuH);

  for (const c of components) {
    c.planeW = mcuCols * c.h * 8;
    c.planeH = mcuRows * c.v * 8;
    c.plane = new Uint8Array(c.planeW * c.planeH);
    c.dcPred = 0;
  }
  const scanMap = new Map(scan.comps.map((s) => [s.id, s]));

  const reader = new BitReader(buf, scan.start);
  const coeff = new Float32Array(64);
  const block = new Float32Array(64);
  const qtable = new Uint16Array(64);

  const decodeBlock = (comp, q, dcTable, acTable) => {
    // de-zigzag quant table
    for (let i = 0; i < 64; i++) qtable[ZIGZAG[i]] = q[ZIGZAG[i]];
    coeff.fill(0);
    const s = decodeHuff(reader, dcTable);
    comp.dcPred += receiveExtend(reader, s);
    coeff[0] = comp.dcPred * qtable[0];
    let k = 1;
    while (k < 64) {
      const rs = decodeHuff(reader, acTable);
      const r = rs >> 4;
      const size = rs & 15;
      if (size === 0) {
        if (r === 15) { k += 16; continue; }
        break;
      }
      k += r;
      if (k > 63) break;
      coeff[ZIGZAG[k]] = receiveExtend(reader, size) * qtable[ZIGZAG[k]];
      k++;
    }
    inverseDCT(coeff, block);
    return block;
  };

  for (let my = 0; my < mcuRows; my++) {
    for (let mx = 0; mx < mcuCols; mx++) {
      for (const comp of components) {
        const sc = scanMap.get(comp.id);
        const dcTable = huffDC[sc.dc];
        const acTable = huffAC[sc.ac];
        const q = quant[comp.tq];
        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            const samples = decodeBlock(comp, q, dcTable, acTable);
            const ox = mx * comp.h * 8 + bx * 8;
            const oy = my * comp.v * 8 + by * 8;
            for (let y = 0; y < 8; y++) {
              const row = (oy + y) * comp.planeW + ox;
              for (let x = 0; x < 8; x++) {
                let v = samples[y * 8 + x];
                v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
                comp.plane[row + x] = v;
              }
            }
          }
        }
      }
    }
  }

  // Compose RGBA.
  const out = new Uint8Array(width * height * 4);
  const comp0 = components[0];
  const sampleAt = (comp, x, y) => {
    const sx = Math.min(comp.planeW - 1, Math.floor((x * comp.h) / maxH));
    const sy = Math.min(comp.planeH - 1, Math.floor((y * comp.v) / maxV));
    return comp.plane[sy * comp.planeW + sx];
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (components.length === 1) {
        const Y = comp0.plane[Math.min(comp0.planeW - 1, Math.floor((x * comp0.h) / maxH)) + Math.min(comp0.planeH - 1, Math.floor((y * comp0.v) / maxV)) * comp0.planeW];
        out[o] = Y; out[o + 1] = Y; out[o + 2] = Y; out[o + 3] = 255;
        continue;
      }
      const Y = sampleAt(components[0], x, y);
      const Cb = sampleAt(components[1], x, y) - 128;
      const Cr = sampleAt(components[2], x, y) - 128;
      let r = Y + 1.402 * Cr;
      let g = Y - 0.344136 * Cb - 0.714136 * Cr;
      let b = Y + 1.772 * Cb;
      out[o] = r < 0 ? 0 : r > 255 ? 255 : r | 0;
      out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
