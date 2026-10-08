/**
 * RGBA raster compositor for the Creation Kernel.
 *
 * A tiny, allocation-conscious 2D canvas over a plain RGBA `Buffer`. Everything
 * the deterministic renderer needs to draw a frame lives here: solid/gradient
 * fills, rounded rectangles, lines, circles, polygons, anti-aliased text (via the
 * bitmap font's coverage masks), scaled image blitting, Ken-Burns viewport
 * extraction, vignette/noise grading, and the scene transitions (crossfade,
 * slide, wipe, zoom). All operations are pure functions over `{width,height,data}`
 * canvases and never touch the network or disk.
 *
 * Blending is standard source-over in straight (non-premultiplied) alpha.
 */

import { parseColor, clamp255, clamp, luminance } from './random.mjs';
import { glyphCoverage, measureLine, measureText, wrapText, FONT_WIDTH, FONT_HEIGHT, GLYPH_SPACING } from './font.mjs';

/** Create a blank RGBA canvas filled with `background` (default transparent). */
export function createCanvas(width, height, background = [0, 0, 0, 0]) {
  const w = Math.max(1, Math.floor(Number(width) || 0));
  const h = Math.max(1, Math.floor(Number(height) || 0));
  const canvas = { width: w, height: h, data: Buffer.alloc(w * h * 4) };
  const [r, g, b, a] = parseColor(background);
  if (r || g || b || a) fill(canvas, [r, g, b, a]);
  return canvas;
}

/** Pack an RGBA tuple into a little-endian 32-bit word. */
function packRgba(r, g, b, a) {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

export function cloneCanvas(canvas) {
  return { width: canvas.width, height: canvas.height, data: Buffer.from(canvas.data) };
}

/** Wrap an existing RGBA buffer as a canvas (no copy). */
export function canvasFromBuffer(width, height, data) {
  return { width: Math.floor(width), height: Math.floor(height), data: Buffer.isBuffer(data) ? data : Buffer.from(data) };
}

export function getPixel(canvas, x, y) {
  const px = Math.floor(x); const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return [0, 0, 0, 0];
  const o = (py * canvas.width + px) * 4;
  return [canvas.data[o], canvas.data[o + 1], canvas.data[o + 2], canvas.data[o + 3]];
}

/** Source-over blend a single pixel. `alpha` (0..1) scales the source alpha. */
export function blendPixel(canvas, x, y, color, alpha = 1) {
  const px = Math.floor(x); const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return;
  const [sr, sg, sb, sa] = parseColor(color);
  const a = (sa / 255) * clamp(alpha, 0, 1);
  if (a <= 0) return;
  const o = (py * canvas.width + px) * 4;
  const dr = canvas.data[o]; const dg = canvas.data[o + 1]; const db = canvas.data[o + 2]; const da = canvas.data[o + 3] / 255;
  const outA = a + da * (1 - a);
  if (outA <= 0) { canvas.data[o] = 0; canvas.data[o + 1] = 0; canvas.data[o + 2] = 0; canvas.data[o + 3] = 0; return; }
  canvas.data[o] = clamp255((sr * a + dr * da * (1 - a)) / outA);
  canvas.data[o + 1] = clamp255((sg * a + dg * da * (1 - a)) / outA);
  canvas.data[o + 2] = clamp255((sb * a + db * da * (1 - a)) / outA);
  canvas.data[o + 3] = clamp255(outA * 255);
}

export function fill(canvas, color) {
  const [r, g, b, a] = parseColor(color);
  const u32 = new Uint32Array(canvas.data.buffer, canvas.data.byteOffset, canvas.width * canvas.height);
  u32.fill(packRgba(r, g, b, a));
  return canvas;
}

export function fillRect(canvas, x, y, w, h, color, alpha = 1) {
  const x0 = Math.max(0, Math.floor(x)); const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(canvas.width, Math.ceil(x + w)); const y1 = Math.min(canvas.height, Math.ceil(y + h));
  if (x1 <= x0 || y1 <= y0) return canvas;
  const [r, g, b, sa] = parseColor(color);
  const a = (sa / 255) * clamp(alpha, 0, 1);
  if (a <= 0) return canvas;
  const data = canvas.data;
  // Fast path: fully opaque source over the whole run → 32-bit row fill.
  if (a >= 1) {
    const pattern = packRgba(r, g, b, 255);
    const width = canvas.width;
    const u32 = new Uint32Array(data.buffer, data.byteOffset, width * canvas.height);
    for (let py = y0; py < y1; py += 1) {
      u32.fill(pattern, py * width + x0, py * width + x1);
    }
    return canvas;
  }
  for (let py = y0; py < y1; py += 1) {
    let o = (py * canvas.width + x0) * 4;
    for (let px = x0; px < x1; px += 1) {
      const da = data[o + 3] / 255;
      const outA = a + da * (1 - a);
      data[o] = clamp255((r * a + data[o] * da * (1 - a)) / outA);
      data[o + 1] = clamp255((g * a + data[o + 1] * da * (1 - a)) / outA);
      data[o + 2] = clamp255((b * a + data[o + 2] * da * (1 - a)) / outA);
      data[o + 3] = clamp255(outA * 255);
      o += 4;
    }
  }
  return canvas;
}

/** Rounded rectangle with a 1px anti-aliased corner via coverage sampling. */
export function fillRoundedRect(canvas, x, y, w, h, radius, color, alpha = 1) {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (r < 0.5) return fillRect(canvas, x, y, w, h, color, alpha);
  const [cr, cg, cb, ca] = parseColor(color);
  const baseAlpha = (ca / 255) * clamp(alpha, 0, 1);
  const x0 = Math.floor(x - 1); const y0 = Math.floor(y - 1);
  const x1 = Math.ceil(x + w + 1); const y1 = Math.ceil(y + h + 1);
  const subs = 4;
  for (let py = Math.max(0, y0); py < Math.min(canvas.height, y1); py += 1) {
    for (let px = Math.max(0, x0); px < Math.min(canvas.width, x1); px += 1) {
      let hits = 0;
      for (let sy = 0; sy < subs; sy += 1) {
        for (let sx = 0; sx < subs; sx += 1) {
          const fx = px + (sx + 0.5) / subs; const fy = py + (sy + 0.5) / subs;
          if (insideRoundedRect(fx, fy, x, y, w, h, r)) hits += 1;
        }
      }
      if (!hits) continue;
      blendPixel(canvas, px, py, [cr, cg, cb, 255], baseAlpha * (hits / (subs * subs)));
    }
  }
  return canvas;
}

function insideRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx; const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * Precompute a 256-entry RGBA lookup table from gradient stops. Building the LUT
 * once and indexing it per pixel removes all per-pixel colour parsing — the
 * single biggest cost in full-frame gradient fills.
 */
function buildColorLut(stops, n = 256) {
  const sorted = [...stops]
    .map((s) => ({ at: Number(s.at) || 0, color: parseColor(s.color) }))
    .sort((a, b) => a.at - b.at);
  const last = sorted.length - 1;
  const lut = new Uint8Array(n * 4);
  for (let i = 0; i < n; i += 1) {
    const t = n === 1 ? 0 : i / (n - 1);
    let c;
    if (t <= sorted[0].at) c = sorted[0].color;
    else if (t >= sorted[last].at) c = sorted[last].color;
    else {
      c = sorted[last].color;
      for (let j = 0; j < last; j += 1) {
        if (t >= sorted[j].at && t <= sorted[j + 1].at) {
          const span = (sorted[j + 1].at - sorted[j].at) || 1;
          const k = (t - sorted[j].at) / span;
          const A = sorted[j].color; const B = sorted[j + 1].color;
          c = [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k, A[3] + (B[3] - A[3]) * k];
          break;
        }
      }
    }
    const o = i * 4;
    lut[o] = c[0] | 0; lut[o + 1] = c[1] | 0; lut[o + 2] = c[2] | 0; lut[o + 3] = c[3] | 0;
  }
  return lut;
}

/** Source-over blend of a pre-parsed colour into a buffer offset (inlined hot path). */
function blendAt(data, o, sr, sg, sb, sa) {
  if (sa <= 0) return;
  const da = data[o + 3];
  if (sa >= 255) { data[o] = sr; data[o + 1] = sg; data[o + 2] = sb; data[o + 3] = 255; return; }
  const a = sa / 255;
  const daF = da / 255;
  const outA = a + daF * (1 - a);
  if (outA <= 0) { data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = 0; return; }
  const ia = a / outA;
  const ib = (daF * (1 - a)) / outA;
  data[o] = (sr * ia + data[o] * ib + 0.5) | 0;
  data[o + 1] = (sg * ia + data[o + 1] * ib + 0.5) | 0;
  data[o + 2] = (sb * ia + data[o + 2] * ib + 0.5) | 0;
  data[o + 3] = (outA * 255 + 0.5) | 0;
}

/** Fill the whole canvas with a linear gradient between two points. */
export function linearGradient(canvas, { from = '#000', to = '#fff', x0 = 0, y0 = 0, x1 = 0, y1 = 1, stops = null } = {}) {
  const W = canvas.width; const H = canvas.height; const data = canvas.data;
  const dx = x1 - x0; const dy = y1 - y0;
  const denom = dx * dx + dy * dy || 1;
  const lut = buildColorLut(stops ?? [{ at: 0, color: from }, { at: 1, color: to }], 256);
  const invW = 1 / (W - 1 || 1); const invH = 1 / (H - 1 || 1);
  const stepX = invW * dx;
  for (let py = 0; py < H; py += 1) {
    const ny = py * invH;
    const base = (ny - y0) * dy - x0 * dx;
    let o = py * W * 4;
    for (let px = 0; px < W; px += 1) {
      let t = (base + px * stepX) / denom;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const li = ((t * 255) | 0) * 4;
      blendAt(data, o, lut[li], lut[li + 1], lut[li + 2], lut[li + 3]);
      o += 4;
    }
  }
  return canvas;
}

/** Radial gradient centred at (cx,cy) in normalised coordinates. */
export function radialGradient(canvas, { cx = 0.5, cy = 0.5, radius = 0.7, stops = [{ at: 0, color: '#fff' }, { at: 1, color: '#000' }] } = {}) {
  const W = canvas.width; const H = canvas.height; const data = canvas.data;
  const lut = buildColorLut(stops, 256);
  const invW = 1 / (W - 1 || 1); const invH = 1 / (H - 1 || 1);
  const invR = 1 / (radius || 1);
  for (let py = 0; py < H; py += 1) {
    const dy = py * invH - cy; const dy2 = dy * dy;
    let o = py * W * 4;
    for (let px = 0; px < W; px += 1) {
      const dxx = px * invW - cx;
      let t = Math.sqrt(dxx * dxx + dy2) * invR;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const li = ((t * 255) | 0) * 4;
      blendAt(data, o, lut[li], lut[li + 1], lut[li + 2], lut[li + 3]);
      o += 4;
    }
  }
  return canvas;
}

/** Draw a line with a soft, coverage-based brush. */
export function drawLine(canvas, x0, y0, x1, y1, color, width = 1, alpha = 1) {
  const [r, g, b, ca] = parseColor(color);
  const baseAlpha = (ca / 255) * clamp(alpha, 0, 1);
  const half = Math.max(0.5, width / 2);
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - half - 1));
  const maxX = Math.min(canvas.width, Math.ceil(Math.max(x0, x1) + half + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - half - 1));
  const maxY = Math.min(canvas.height, Math.ceil(Math.max(y0, y1) + half + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      let t = ((cx - x0) * dx + (cy - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const nx = x0 + t * dx;
      const ny = y0 + t * dy;
      const dist = Math.hypot(cx - nx, cy - ny);
      const cov = clamp(half + 0.5 - dist, 0, 1);
      if (cov > 0) blendPixel(canvas, px, py, [r, g, b, 255], baseAlpha * cov);
    }
  }
  return canvas;
}

export function fillCircle(canvas, cx, cy, radius, color, alpha = 1) {
  const [r, g, b, ca] = parseColor(color);
  const baseAlpha = (ca / 255) * clamp(alpha, 0, 1);
  const subs = 3;
  const x0 = Math.max(0, Math.floor(cx - radius - 1)); const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const x1 = Math.min(canvas.width, Math.ceil(cx + radius + 1)); const y1 = Math.min(canvas.height, Math.ceil(cy + radius + 1));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      let hits = 0;
      for (let sy = 0; sy < subs; sy += 1) {
        for (let sx = 0; sx < subs; sx += 1) {
          const fx = px + (sx + 0.5) / subs; const fy = py + (sy + 0.5) / subs;
          if ((fx - cx) ** 2 + (fy - cy) ** 2 <= radius * radius) hits += 1;
        }
      }
      if (hits) blendPixel(canvas, px, py, [r, g, b, 255], baseAlpha * (hits / (subs * subs)));
    }
  }
  return canvas;
}

/** Draw a filled convex/concave polygon from a list of [x,y] points (even-odd). */
export function fillPolygon(canvas, points, color, alpha = 1) {
  if (points.length < 3) return canvas;
  const ys = points.map((p) => p[1]);
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(canvas.height - 1, Math.ceil(Math.max(...ys)));
  for (let y = minY; y <= maxY; y += 1) {
    const xs = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]; const b = points[(i + 1) % points.length];
      if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) fillRect(canvas, xs[i], y, xs[i + 1] - xs[i], 1, color, alpha);
  }
  return canvas;
}

/* -------------------------------------------------------------------------- */
/*  Text                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Draw text with the bitmap font.
 * @param {object} canvas
 * @param {string} text
 * @param {object} options x,y,color,scale,letterSpacing,lineSpacing,align,maxWidth,wrap,
 *                         background,backgroundPadding,shadow,opacity,anchor
 */
export function drawText(canvas, text, options = {}) {
  const {
    x = 0, y = 0, color = '#ffffff', scale = 2, letterSpacing = 1, lineSpacing = 2,
    align = 'left', maxWidth = Infinity, wrap = false, background = null,
    backgroundPadding = 0, backgroundRadius = 0, shadow = null, opacity = 1, anchor = 'top',
  } = options;
  const lines = wrap && Number.isFinite(maxWidth)
    ? wrapText(text, maxWidth, { scale, letterSpacing })
    : String(text ?? '').split('\n');
  const block = measureText(lines.join('\n'), { scale, letterSpacing, lineSpacing });
  let originY = y;
  if (anchor === 'middle') originY = y - block.height / 2;
  else if (anchor === 'bottom') originY = y - block.height;

  if (background) {
    const pad = backgroundPadding;
    let bgWidth = block.width + pad * 2;
    let bgX = x - pad;
    if (align === 'center') bgX = x - bgWidth / 2;
    else if (align === 'right') bgX = x - bgWidth;
    const bgY = originY - pad;
    const bgHeight = block.height + pad * 2;
    if (backgroundRadius > 0) fillRoundedRect(canvas, bgX, bgY, bgWidth, bgHeight, backgroundRadius, background, opacity);
    else fillRect(canvas, bgX, bgY, bgWidth, bgHeight, background, opacity);
  }

  const advance = (FONT_WIDTH + letterSpacing) * scale;
  let cursorY = originY;
  for (const line of lines) {
    const lineWidth = measureLine(line, { scale, letterSpacing }).width;
    let cursorX = x;
    if (align === 'center') cursorX = x - lineWidth / 2;
    else if (align === 'right') cursorX = x - lineWidth;
    for (const char of line) {
      if (char !== ' ') {
        const { width, height, coverage } = glyphCoverage(char, { scale });
        if (shadow) drawCoverage(canvas, cursorX + (shadow.dx ?? 1), cursorY + (shadow.dy ?? 1), width, height, coverage, shadow.color ?? '#000000', (shadow.opacity ?? 0.5) * opacity);
        drawCoverage(canvas, cursorX, cursorY, width, height, coverage, color, opacity);
      }
      cursorX += advance;
    }
    cursorY += block.lineHeight;
  }
  return canvas;
}

/** Alpha-blend a coverage mask (0..1 per pixel) with a solid colour. */
export function drawCoverage(canvas, x, y, width, height, coverage, color, alpha = 1) {
  const [r, g, b, ca] = parseColor(color);
  const baseAlpha = (ca / 255) * clamp(alpha, 0, 1);
  if (baseAlpha <= 0) return canvas;
  const data = canvas.data;
  const cw = canvas.width; const ch = canvas.height;
  const ox = Math.floor(x); const oy = Math.floor(y);
  for (let py = 0; py < height; py += 1) {
    const dy = oy + py;
    if (dy < 0 || dy >= ch) continue;
    let o = (dy * cw + ox) * 4;
    const rowOff = py * width;
    for (let px = 0; px < width; px += 1) {
      const cov = coverage[rowOff + px];
      const dx = ox + px;
      if (cov > 0 && dx >= 0 && dx < cw) {
        blendAt(data, o, r, g, b, baseAlpha * cov * 255);
      }
      o += 4;
    }
  }
  return canvas;
}

/** Draw a text block with an automatic contrast-aware scrim behind it. */
export function drawCaption(canvas, text, options = {}) {
  const { color = '#ffffff', background = 'rgba(6,10,16,0.55)', ...rest } = options;
  return drawText(canvas, text, { color, background, backgroundPadding: 12, backgroundRadius: 8, ...rest });
}

/* -------------------------------------------------------------------------- */
/*  Image sampling / blitting / viewport extraction                           */
/* -------------------------------------------------------------------------- */

/**
 * Bilinear resample `src` into a new (width,height) canvas. Inlined and
 * allocation-free (the previous array-per-sample version dominated cost when
 * scaling provider images).
 */
export function resizeCanvas(src, width, height) {
  const W = Math.max(1, Math.floor(width)); const H = Math.max(1, Math.floor(height));
  const out = { width: W, height: H, data: Buffer.alloc(W * H * 4) };
  const sd = src.data; const od = out.data;
  const sw = src.width; const sh = src.height;
  const xScale = sw / W; const yScale = sh / H;
  for (let py = 0; py < H; py += 1) {
    let sy = (py + 0.5) * yScale - 0.5;
    let y0 = Math.floor(sy); let fy = sy - y0;
    if (y0 < 0) { y0 = 0; fy = 0; }
    let y1 = y0 + 1; if (y1 >= sh) y1 = sh - 1;
    const row0 = y0 * sw * 4; const row1 = y1 * sw * 4;
    const w0y = 1 - fy; const w1y = fy;
    let o = py * W * 4;
    for (let px = 0; px < W; px += 1) {
      let sx = (px + 0.5) * xScale - 0.5;
      let x0 = Math.floor(sx); let fx = sx - x0;
      if (x0 < 0) { x0 = 0; fx = 0; }
      let x1 = x0 + 1; if (x1 >= sw) x1 = sw - 1;
      const i00 = row0 + x0 * 4; const i10 = row0 + x1 * 4;
      const i01 = row1 + x0 * 4; const i11 = row1 + x1 * 4;
      const w00 = (1 - fx) * w0y; const w10 = fx * w0y;
      const w01 = (1 - fx) * w1y; const w11 = fx * w1y;
      od[o] = (sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11 + 0.5) | 0;
      od[o + 1] = (sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11 + 0.5) | 0;
      od[o + 2] = (sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11 + 0.5) | 0;
      od[o + 3] = (sd[i00 + 3] * w00 + sd[i10 + 3] * w10 + sd[i01 + 3] * w01 + sd[i11 + 3] * w11 + 0.5) | 0;
      o += 4;
    }
  }
  return out;
}

/**
 * Blit `src` onto `dest` at (x,y), optionally scaled to (w,h) with opacity.
 * `fit` = 'cover' | 'contain' | 'stretch' when w/h are given.
 */
export function blit(dest, src, { x = 0, y = 0, w = null, h = null, alpha = 1, fit = 'stretch' } = {}) {
  let source = src;
  let targetW = w ?? src.width;
  let targetH = h ?? src.height;
  if (w && h && fit !== 'stretch') {
    const scale = fit === 'cover' ? Math.max(w / src.width, h / src.height) : Math.min(w / src.width, h / src.height);
    targetW = Math.round(src.width * scale);
    targetH = Math.round(src.height * scale);
  }
  if (targetW !== src.width || targetH !== src.height) source = resizeCanvas(src, Math.max(1, targetW), Math.max(1, targetH));
  const ox = Math.round(x); const oy = Math.round(y);
  const sd = source.data; const dd = dest.data;
  const dw = dest.width; const dh = dest.height;
  const sw = source.width;
  const a = clamp(alpha, 0, 1);
  if (a <= 0) return dest;
  for (let py = 0; py < source.height; py += 1) {
    const dy = oy + py;
    if (dy < 0 || dy >= dh) continue;
    let so = py * sw * 4;
    let doff = (dy * dw + ox) * 4;
    for (let px = 0; px < sw; px += 1) {
      const dx = ox + px;
      if (dx >= 0 && dx < dw) {
        const sa = sd[so + 3];
        if (sa > 0) {
          const eff = (sa / 255) * a * 255;
          blendAt(dd, doff, sd[so], sd[so + 1], sd[so + 2], eff);
        }
      }
      so += 4; doff += 4;
    }
  }
  return dest;
}

/**
 * Extract a rectangular viewport (in normalised 0..1 source coordinates) into an
 * output canvas of (outW,outH). This is the primitive behind the Ken-Burns move.
 */
export function extractViewport(src, viewport, outW, outH) {
  const W = Math.max(1, Math.floor(outW)); const H = Math.max(1, Math.floor(outH));
  const out = { width: W, height: H, data: Buffer.alloc(W * H * 4) };
  const sd = src.data; const od = out.data; const sw = src.width; const sh = src.height;
  const vx = clamp(viewport.x ?? 0, 0, 1);
  const vy = clamp(viewport.y ?? 0, 0, 1);
  const vw = clamp(viewport.w ?? 1, 0.001, 1);
  const vh = clamp(viewport.h ?? 1, 0.001, 1);
  const sx0 = vx * sw; const sy0 = vy * sh;
  const xScale = (vw * sw) / W; const yScale = (vh * sh) / H;
  // The horizontal sample mapping is identical for every row — precompute it once.
  const x0Arr = new Int32Array(W); const x1Arr = new Int32Array(W);
  const fxArr = new Float32Array(W);
  for (let px = 0; px < W; px += 1) {
    let sx = sx0 + (px + 0.5) * xScale - 0.5;
    let x0 = Math.floor(sx); let fx = sx - x0;
    if (x0 < 0) { x0 = 0; fx = 0; }
    let x1 = x0 + 1; if (x1 >= sw) x1 = sw - 1;
    x0Arr[px] = x0; x1Arr[px] = x1; fxArr[px] = fx;
  }
  for (let py = 0; py < H; py += 1) {
    let sy = sy0 + (py + 0.5) * yScale - 0.5;
    let y0 = Math.floor(sy); let fy = sy - y0;
    if (y0 < 0) { y0 = 0; fy = 0; }
    let y1 = y0 + 1; if (y1 >= sh) y1 = sh - 1;
    const row0 = y0 * sw * 4; const row1 = y1 * sw * 4;
    const w0y = 1 - fy; const w1y = fy;
    let o = py * W * 4;
    for (let px = 0; px < W; px += 1) {
      const x0 = x0Arr[px]; const x1 = x1Arr[px]; const fx = fxArr[px];
      const i00 = row0 + x0 * 4; const i10 = row0 + x1 * 4;
      const i01 = row1 + x0 * 4; const i11 = row1 + x1 * 4;
      const w00 = (1 - fx) * w0y; const w10 = fx * w0y;
      const w01 = (1 - fx) * w1y; const w11 = fx * w1y;
      od[o] = (sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11 + 0.5) | 0;
      od[o + 1] = (sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11 + 0.5) | 0;
      od[o + 2] = (sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11 + 0.5) | 0;
      od[o + 3] = (sd[i00 + 3] * w00 + sd[i10 + 3] * w10 + sd[i01 + 3] * w01 + sd[i11 + 3] * w11 + 0.5) | 0;
      o += 4;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Grading                                                                   */
/* -------------------------------------------------------------------------- */

/** Darken the edges with a smooth radial vignette. */
export function vignette(canvas, strength = 0.35) {
  const W = canvas.width; const H = canvas.height; const data = canvas.data;
  const cx = W / 2; const cy = H / 2;
  const invMax = 1 / (Math.sqrt(cx * cx + cy * cy) || 1);
  const s = clamp(strength, 0, 1);
  for (let py = 0; py < H; py += 1) {
    const dy = py + 0.5 - cy; const dy2 = dy * dy;
    let o = py * W * 4;
    for (let px = 0; px < W; px += 1) {
      const dx = px + 0.5 - cx;
      const dist = Math.sqrt(dx * dx + dy2) * invMax;
      let amount = (dist - 0.45) / 0.55;
      if (amount > 0) {
        if (amount > 1) amount = 1;
        const k = 1 - amount * s;
        data[o] = (data[o] * k + 0.5) | 0;
        data[o + 1] = (data[o + 1] * k + 0.5) | 0;
        data[o + 2] = (data[o + 2] * k + 0.5) | 0;
      }
      o += 4;
    }
  }
  return canvas;
}

/** Add monochrome film grain. `rng` must be a seeded RNG for determinism. */
export function addNoise(canvas, amount, rng) {
  const data = canvas.data;
  const count = canvas.width * canvas.height;
  const amp = 255 * clamp(amount, 0, 1);
  if (amp <= 0) return canvas;
  // Seed an inlined xorshift32 from the shared RNG so the grain stays
  // deterministic yet costs ~3 ops/pixel instead of a closure call.
  let s = rng ? (Math.floor(rng.next() * 4294967296) >>> 0) : 0x9e3779b9;
  if (s === 0) s = 0x9e3779b9;
  for (let i = 0; i < count; i += 1) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    const n = (s / 4294967296 - 0.5) * amp;
    const o = i * 4;
    let r = data[o] + n; let g = data[o + 1] + n; let b = data[o + 2] + n;
    data[o] = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
    data[o + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
    data[o + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
  }
  return canvas;
}

/** Multiply the whole frame by a tint colour (0..1 per channel). */
export function tint(canvas, color, amount = 0.3) {
  const [r, g, b] = parseColor(color);
  const k = clamp(amount, 0, 1);
  for (let i = 0; i < canvas.width * canvas.height; i += 1) {
    const o = i * 4;
    canvas.data[o] = clamp255(canvas.data[o] * (1 - k) + r * k);
    canvas.data[o + 1] = clamp255(canvas.data[o + 1] * (1 - k) + g * k);
    canvas.data[o + 2] = clamp255(canvas.data[o + 2] * (1 - k) + b * k);
  }
  return canvas;
}

/* -------------------------------------------------------------------------- */
/*  Transitions                                                               */
/* -------------------------------------------------------------------------- */

export function crossfade(a, b, t) {
  const out = createCanvas(a.width, a.height);
  const k = clamp(t, 0, 1);
  for (let i = 0; i < a.width * a.height; i += 1) {
    const o = i * 4;
    for (let c = 0; c < 4; c += 1) out.data[o + c] = clamp255(a.data[o + c] * (1 - k) + b.data[o + c] * k);
  }
  return out;
}

export function slideTransition(a, b, t, direction = 'left') {
  const out = createCanvas(a.width, a.height);
  const k = clamp(t, 0, 1);
  const offset = Math.round((direction === 'left' || direction === 'right' ? a.width : a.height) * k);
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? 1 : -1;
  blit(out, a, { x: horizontal ? -offset * sign : 0, y: horizontal ? 0 : -offset * sign });
  blit(out, b, { x: horizontal ? (a.width - offset) * sign : 0, y: horizontal ? 0 : (a.height - offset) * sign });
  return out;
}

export function wipeTransition(a, b, t, direction = 'left') {
  const out = cloneCanvas(a);
  const k = clamp(t, 0, 1);
  let x0 = 0; let y0 = 0; let x1 = out.width; let y1 = out.height;
  if (direction === 'left') x1 = Math.round(out.width * k);
  else if (direction === 'right') x0 = out.width - Math.round(out.width * k);
  else if (direction === 'up') y1 = Math.round(out.height * k);
  else y0 = out.height - Math.round(out.height * k);
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const o = (py * out.width + px) * 4;
      out.data[o] = b.data[o]; out.data[o + 1] = b.data[o + 1]; out.data[o + 2] = b.data[o + 2]; out.data[o + 3] = b.data[o + 3];
    }
  }
  return out;
}

/** Crossfade with a subtle push-in on the incoming frame. */
export function zoomTransition(a, b, t, { from = 1.12, to = 1.0 } = {}) {
  const k = clamp(t, 0, 1);
  const scale = from + (to - from) * k;
  const zoomed = extractViewport(b, { x: (1 - 1 / scale) / 2, y: (1 - 1 / scale) / 2, w: 1 / scale, h: 1 / scale }, b.width, b.height);
  return crossfade(a, zoomed, k);
}

/** Apply a transition by name (falls back to crossfade). */
export function applyTransition(name, a, b, t, options = {}) {
  switch (String(name)) {
    case 'cut': return t < 0.5 ? cloneCanvas(a) : cloneCanvas(b);
    case 'slide': return slideTransition(a, b, t, options.direction ?? 'left');
    case 'wipe': return wipeTransition(a, b, t, options.direction ?? 'left');
    case 'zoom': return zoomTransition(a, b, t, options);
    case 'fade':
    case 'crossfade':
    default: return crossfade(a, b, t);
  }
}

/** Average luminance of a frame (used by the critic for exposure checks). */
export function frameLuminance(canvas) {
  let total = 0;
  const count = canvas.width * canvas.height;
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    total += (0.2126 * canvas.data[o] + 0.7152 * canvas.data[o + 1] + 0.0722 * canvas.data[o + 2]) / 255;
  }
  return total / count;
}

/** Mean absolute per-channel difference between two same-size frames (0..1). */
export function frameDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let total = 0;
  const count = a.width * a.height * 3;
  for (let i = 0; i < a.width * a.height; i += 1) {
    const o = i * 4;
    total += Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]);
  }
  return total / (count * 255);
}

export { luminance };
