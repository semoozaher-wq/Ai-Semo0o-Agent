/**
 * Deterministic randomness + color helpers for the Creation Kernel.
 *
 * The whole media pipeline must be *reproducible*: the same brief, the same
 * seed and the same code must produce byte-identical output. That is what makes
 * a render auditable, cacheable and testable. So every stochastic decision in
 * the kernel (dithering, particle placement, procedural music, camera drift)
 * draws from a seeded PRNG defined here rather than `Math.random()`.
 *
 * Nothing in this module touches the network or the filesystem.
 */

/** FNV-1a 32-bit hash of a string -> a stable numeric seed. */
export function hashSeed(value) {
  const text = String(value ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: tiny, fast, well-distributed 32-bit PRNG. Returns floats in [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a small, ergonomic RNG object from any seed (number or string).
 * @param {number|string} seed
 */
export function createRng(seed) {
  const numeric = typeof seed === 'number' && Number.isFinite(seed) ? seed >>> 0 : hashSeed(seed);
  const next = mulberry32(numeric);
  return {
    seed: numeric,
    next,
    /** Uniform float in [min, max). */
    range(min, max) { return min + (max - min) * next(); },
    /** Uniform integer in [min, max] inclusive. */
    int(min, max) { return Math.floor(min + (max - min + 1) * next()); },
    /** Pick a random element of an array. */
    pick(list) { return list[Math.floor(next() * list.length)]; },
    /** True with probability p. */
    bool(p = 0.5) { return next() < p; },
    /** Approximate standard-normal sample (sum of 3 uniforms, centred). */
    gauss() { return ((next() + next() + next()) - 1.5) * 2; },
    /** In-place Fisher–Yates shuffle; returns the same array. */
    shuffle(list) {
      for (let i = list.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Color helpers                                                             */
/* -------------------------------------------------------------------------- */

export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
export const clamp255 = (value) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb()/rgba()` into [r,g,b,a]. */
export function parseColor(input) {
  if (Array.isArray(input)) return [clamp255(input[0]), clamp255(input[1]), clamp255(input[2]), input.length > 3 ? clamp255(input[3]) : 255];
  const text = String(input ?? '').trim();
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    if (hex.length === 3) return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16), 255];
    if (hex.length === 6) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];
    if (hex.length === 8) return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), parseInt(hex.slice(6, 8), 16)];
  }
  const match = text.match(/rgba?\(([^)]+)\)/i);
  if (match) {
    const parts = match[1].split(',').map((part) => Number(part.trim()));
    return [clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2]), parts.length > 3 ? clamp255(parts[3] * 255) : 255];
  }
  return [0, 0, 0, 255];
}

export function toHex(color) {
  const [r, g, b] = parseColor(color);
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/** Linear interpolation between two colors in RGBA space. */
export function mixColors(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const k = clamp(t, 0, 1);
  return [clamp255(lerp(ca[0], cb[0], k)), clamp255(lerp(ca[1], cb[1], k)), clamp255(lerp(ca[2], cb[2], k)), clamp255(lerp(ca[3], cb[3], k))];
}

/** Scale a color's brightness by `factor` (0..2 typical). */
export function shade(color, factor) {
  const [r, g, b, a] = parseColor(color);
  return [clamp255(r * factor), clamp255(g * factor), clamp255(b * factor), a];
}

/** HSL (h in degrees, s/l in 0..1) -> [r,g,b,a]. */
export function hsl(h, s, l, a = 255) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [clamp255((rgb[0] + m) * 255), clamp255((rgb[1] + m) * 255), clamp255((rgb[2] + m) * 255), clamp255(a)];
}

/** Relative luminance (0..1) used for contrast decisions in the composer. */
export function luminance(color) {
  const [r, g, b] = parseColor(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Pick black or white text for maximum contrast against `background`. */
export function contrastText(background) {
  return luminance(background) > 0.55 ? '#0b0f14' : '#f8fafc';
}
