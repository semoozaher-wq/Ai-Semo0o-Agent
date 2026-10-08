import assert from 'node:assert/strict';
import test from 'node:test';

import { createRng, parseColor, mixColors, hashSeed } from '../media/random.mjs';
import { encodePng, decodePng, pngDimensions, crc32 } from '../media/png.mjs';
import { glyphFor, measureText, wrapText, glyphCoverage, isPrintable, FONT_HEIGHT } from '../media/font.mjs';
import {
  createCanvas, getPixel, fillRect, fillCircle, fillPolygon, drawLine,
  linearGradient, radialGradient, drawText, resizeCanvas, blit,
  extractViewport, vignette, addNoise, applyTransition, frameDifference,
} from '../media/raster.mjs';
import { encodeGif, parseGif, lzwEncode, medianCut, buildPaletteFromFrames } from '../media/gif.mjs';
import { encodeJpeg, jpegDimensions } from '../media/jpeg.mjs';
import { encodeAvi, parseAvi } from '../media/avi.mjs';
import {
  createPcm, toInt16, fromInt16, pcmDuration, mix, applyGain, applyFade,
  normalize, resample, concat, tone, composeMusic, upmix, noteFreq, silence,
} from '../media/audio.mjs';
import { createTimeline, validateTimeline, normalizeTimeline, sceneAt, timelineDuration } from '../media/timeline.mjs';
import { renderTimeline, renderToArtifacts, framesToGif, framesToAvi, easing } from '../media/render.mjs';

/* ------------------------------------------------------------------ */
/* Deterministic randomness + colour                                   */
/* ------------------------------------------------------------------ */

test('random: seeded RNG is deterministic and bounded', () => {
  const a = createRng('seed-1');
  const b = createRng('seed-1');
  const c = createRng('seed-2');
  const seqA = Array.from({ length: 8 }, () => a.next());
  const seqB = Array.from({ length: 8 }, () => b.next());
  const seqC = Array.from({ length: 8 }, () => c.next());
  assert.deepEqual(seqA, seqB, 'same seed → same sequence');
  assert.notDeepEqual(seqA, seqC, 'different seed → different sequence');
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  const r = createRng('x');
  for (let i = 0; i < 100; i++) {
    const n = r.int(3, 7);
    assert.ok(n >= 3 && n <= 7);
  }
  assert.equal(hashSeed('abc'), hashSeed('abc'));
});

test('random: colour parsing and mixing', () => {
  assert.deepEqual(parseColor('#ff0000'), [255, 0, 0, 255]);
  assert.deepEqual(parseColor('rgba(0,128,255,0.5)'), [0, 128, 255, 128]);
  const mixed = mixColors('#000000', '#ffffff', 0.5);
  assert.equal(mixed[0], 128);
});

/* ------------------------------------------------------------------ */
/* PNG codec                                                           */
/* ------------------------------------------------------------------ */

test('png: crc32 matches the reference vector', () => {
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
});

test('png: byte-exact round trip across sizes', () => {
  for (const [w, h] of [[1, 1], [64, 48], [200, 3], [3, 200], [37, 37]]) {
    const canvas = createCanvas(w, h, '#102030');
    const rng = createRng(`png-${w}x${h}`);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        canvas.data[i] = rng.int(0, 255);
        canvas.data[i + 1] = rng.int(0, 255);
        canvas.data[i + 2] = rng.int(0, 255);
        canvas.data[i + 3] = 255;
      }
    }
    const png = encodePng(canvas);
    assert.deepEqual(pngDimensions(png), { width: w, height: h });
    const back = decodePng(png);
    assert.equal(back.width, w);
    assert.equal(back.height, h);
    assert.deepEqual(Buffer.from(back.data), Buffer.from(canvas.data), `round trip ${w}x${h}`);
  }
});

/* ------------------------------------------------------------------ */
/* Font + raster                                                       */
/* ------------------------------------------------------------------ */

test('font: glyphs, measurement and wrapping', () => {
  assert.ok(glyphFor('A'));
  assert.equal(isPrintable('\n'), false);
  assert.equal(glyphFor(' ').length, 5);
  const m = measureText('Hello', { scale: 2 });
  assert.ok(m.width > 0 && m.height > 0);
  const wrapped = wrapText('the quick brown fox jumps over the lazy dog', 60, { scale: 1 });
  assert.ok(wrapped.length > 1);
  const cov = glyphCoverage('A', { scale: 4 });
  assert.equal(cov.width, 20);
  assert.ok(cov.coverage.some((v) => v > 0));
  assert.ok(FONT_HEIGHT > 0);
});

test('raster: primitives mutate pixels as expected', () => {
  const c = createCanvas(40, 40, '#000000');
  fillRect(c, 10, 10, 10, 10, '#ff0000');
  assert.deepEqual(getPixel(c, 15, 15), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(c, 0, 0), [0, 0, 0, 255]);
  fillCircle(c, 30, 30, 5, '#00ff00');
  assert.deepEqual(getPixel(c, 30, 30), [0, 255, 0, 255]);
  fillPolygon(c, [[0, 39], [10, 20], [20, 39]], '#0000ff');
  assert.equal(getPixel(c, 10, 35)[2], 255);
  drawLine(c, 0, 20, 39, 20, '#ffffff', 2);
  assert.ok(getPixel(c, 20, 20)[0] > 200, 'line is bright at its core');
});

test('raster: gradients, text, resize, blit, viewport, transitions', () => {
  const c = createCanvas(80, 60, '#000000');
  linearGradient(c, { from: '#000000', to: '#ffffff', x0: 0, y0: 0, x1: 0, y1: 60 });
  assert.ok(getPixel(c, 40, 55)[0] > getPixel(c, 40, 5)[0]);
  radialGradient(c, { cx: 0.5, cy: 0.5, radius: 0.5, stops: [{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }] });
  drawText(c, 'AB', { x: 4, y: 4, color: '#ff0000', scale: 2 });
  const resized = resizeCanvas(c, 40, 30);
  assert.equal(resized.width, 40);
  const dest = createCanvas(80, 60, '#000000');
  blit(dest, resized, { x: 0, y: 0, w: 80, h: 60, fit: 'cover' });
  const view = extractViewport(c, { x: 10, y: 10, w: 40, h: 30 }, 40, 30);
  assert.equal(view.width, 40);
  vignette(c, 0.4);
  addNoise(c, 0.05, createRng('n'));
  const a = createCanvas(20, 20, '#ff0000');
  const b = createCanvas(20, 20, '#0000ff');
  for (const name of ['crossfade', 'slide', 'wipe', 'zoom']) {
    const f = applyTransition(name, a, b, 0.5);
    assert.equal(f.width, 20);
  }
  assert.ok(frameDifference(a, b) > 0);
});

/* ------------------------------------------------------------------ */
/* GIF                                                                 */
/* ------------------------------------------------------------------ */

function lzwDecode(bytes, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict[i] = [i];
    dict[clearCode] = [];
    dict[endCode] = null;
    codeSize = minCodeSize + 1;
  };
  reset();
  const out = [];
  let bitPos = 0;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = bytes[bitPos >> 3];
      if (byte === undefined) return -1;
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };
  let prev = null;
  for (;;) {
    const code = readCode();
    if (code === -1) break;
    if (code === clearCode) { reset(); prev = null; continue; }
    if (code === endCode) break;
    let entry;
    if (dict[code] !== undefined) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else throw new Error('bad code');
    out.push(...entry);
    if (prev) {
      dict.push(prev.concat([entry[0]]));
      if (dict.length > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return Uint8Array.from(out);
}

test('gif: LZW round-trips arbitrary index streams', () => {
  for (const kind of ['gradient', 'random', 'flat']) {
    const n = 4000;
    const idx = new Uint8Array(n);
    const rng = createRng('lzw-' + kind);
    for (let i = 0; i < n; i++) {
      idx[i] = kind === 'gradient' ? i % 256 : kind === 'flat' ? 7 : rng.int(0, 255);
    }
    const enc = lzwEncode(idx, 8);
    const dec = lzwDecode(enc, 8);
    assert.deepEqual(dec, idx, kind);
  }
});

test('gif: median cut produces bounded palette', () => {
  const rng = createRng('mc');
  const colors = [];
  for (let i = 0; i < 5000; i++) colors.push([rng.int(0, 255), rng.int(0, 255), rng.int(0, 255)]);
  const pal = medianCut(colors, 16);
  assert.ok(pal.length <= 16 && pal.length > 1);
  for (const c of pal) assert.ok(c[0] >= 0 && c[0] <= 255);
});

test('gif: encodes a valid animated container', () => {
  const frames = [];
  for (let i = 0; i < 5; i++) {
    const c = createCanvas(48, 32, '#101820');
    fillRect(c, i * 6, 8, 12, 16, '#ff8800');
    frames.push({ data: c.data, delayMs: 100 });
  }
  const gif = encodeGif({ width: 48, height: 32, frames, loop: 0 });
  const meta = parseGif(gif);
  assert.equal(meta.version, 'GIF89a');
  assert.equal(meta.width, 48);
  assert.equal(meta.height, 32);
  assert.equal(meta.frames, 5);
  assert.equal(meta.loop, 0);
  assert.ok(gif.length > 100);
});

/* ------------------------------------------------------------------ */
/* JPEG + AVI                                                          */
/* ------------------------------------------------------------------ */

test('jpeg: encodes decodable-looking streams with correct dimensions', () => {
  const c = createCanvas(64, 48, '#204060');
  fillCircle(c, 32, 24, 12, '#ffcc00');
  for (const quality of [90, 70, 40]) {
    const jpg = encodeJpeg({ width: 64, height: 48, data: c.data, quality, subsample: '420' });
    assert.equal(jpg[0], 0xff);
    assert.equal(jpg[1], 0xd8);
    assert.equal(jpg[jpg.length - 2], 0xff);
    assert.equal(jpg[jpg.length - 1], 0xd9);
    assert.deepEqual(jpegDimensions(jpg), { width: 64, height: 48, components: 3 });
  }
  const gray = encodeJpeg({ width: 64, height: 48, data: c.data, quality: 80, grayscale: true });
  assert.equal(jpegDimensions(gray).components, 1);
});

test('avi: encodes a structurally valid RIFF/AVI with interleaved audio', () => {
  const W = 96, H = 64, fps = 10, n = 10;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const c = createCanvas(W, H, '#000000');
    fillRect(c, i * 8, 10, 16, 30, '#00ccff');
    frames.push(encodeJpeg({ width: W, height: H, data: c.data, quality: 75 }));
  }
  const pcm = Buffer.alloc(22050 * 2);
  for (let i = 0; i < 22050; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  const avi = encodeAvi({ width: W, height: H, fps, frames, audio: { sampleRate: 22050, channels: 1, data: pcm } });
  assert.equal(avi.toString('latin1', 0, 4), 'RIFF');
  assert.equal(avi.toString('latin1', 8, 12), 'AVI ');
  const meta = parseAvi(avi);
  assert.equal(meta.width, W);
  assert.equal(meta.height, H);
  assert.equal(meta.totalFrames, n);
  assert.equal(meta.streams, 2);
  assert.equal(meta.hasAudio, true);
  assert.equal(meta.indexEntries, n + n); // one video + one audio chunk per frame
});

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

test('audio: PCM helpers are correct', () => {
  const pcm = tone({ freq: 440, seconds: 0.5, sampleRate: 22050, gain: 0.5 });
  assert.equal(Math.round(pcmDuration(pcm) * 1000), 500);
  const int16 = toInt16(pcm);
  assert.equal(int16.length, pcm.data.length * 2);
  const back = fromInt16(int16, 22050, 1);
  assert.ok(Math.abs(back.data[100] - pcm.data[100]) < 0.001);
  const louder = applyGain(createPcm(22050, 1, 100), 2);
  assert.equal(louder.data.length, 100);
  const faded = applyFade(tone({ freq: 200, seconds: 1, gain: 1 }), { inSec: 0.2, outSec: 0.2 });
  assert.ok(Math.abs(faded.data[0]) < 0.01);
  const norm = normalize(tone({ freq: 300, seconds: 0.2, gain: 0.1 }), 0.9);
  let peak = 0;
  for (const v of norm.data) peak = Math.max(peak, Math.abs(v));
  assert.ok(Math.abs(peak - 0.9) < 0.02);
  const rs = resample(tone({ freq: 300, seconds: 0.2, sampleRate: 22050 }), 11025);
  assert.equal(rs.sampleRate, 11025);
  const joined = concat(silence(22050, 1, 0.1), silence(22050, 1, 0.1));
  assert.equal(Math.round(pcmDuration(joined) * 1000), 200);
  assert.equal(noteFreq(69), 440);
});

test('audio: procedural music is deterministic and non-silent', () => {
  const a = composeMusic({ seed: 'goal', seconds: 3, mood: 'uplifting', sampleRate: 22050 });
  const b = composeMusic({ seed: 'goal', seconds: 3, mood: 'uplifting', sampleRate: 22050 });
  assert.deepEqual(Buffer.from(a.data), Buffer.from(b.data), 'deterministic');
  let peak = 0;
  for (const v of a.data) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.3, 'music has energy');
  const stereo = upmix(a, 2);
  assert.equal(stereo.channels, 2);
  assert.equal(stereo.data.length, a.data.length * 2);
});

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

test('timeline: normalises, validates and locates scenes', () => {
  const tl = createTimeline({
    width: 320, height: 180, fps: 10, seed: 's',
    scenes: [
      { duration: 2, layers: [{ type: 'text', text: 'one' }] },
      { duration: 3, layers: [{ type: 'text', text: 'two' }] },
    ],
  });
  assert.equal(timelineDuration(tl), 5);
  assert.equal(tl.meta.totalFrames, 50);
  assert.equal(tl.scenes[0].start, 0);
  assert.equal(tl.scenes[1].start, 2);
  const v = validateTimeline(tl);
  assert.equal(v.ok, true);
  assert.equal(sceneAt(tl, 0.5).scene.id, tl.scenes[0].id);
  assert.equal(sceneAt(tl, 4).scene.id, tl.scenes[1].id);
  const bad = validateTimeline({ version: 1, meta: { width: 0, height: 0, fps: 0 }, scenes: [] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 1);
});

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

test('render: produces deterministic frames of the right size', () => {
  const tl = createTimeline({
    width: 64, height: 48, fps: 8, seed: 'r',
    scenes: [{
      duration: 1,
      background: { type: 'gradient', from: '#112233', to: '#000000' },
      layers: [{ type: 'text', text: 'hi', x: 4, y: 4, scale: 1, animate: { type: 'fadeIn' } }],
    }],
  });
  const out = renderTimeline(tl, { includeAudio: false });
  assert.equal(out.frames.length, 8);
  assert.equal(out.frames[0].width, 64);
  assert.equal(out.frames[0].height, 48);
  const again = renderTimeline(tl, { includeAudio: false });
  assert.deepEqual(Buffer.from(out.frames[3].data), Buffer.from(again.frames[3].data), 'deterministic render');
});

test('render: full pipeline yields GIF + AVI artefacts', () => {
  const tl = createTimeline({
    width: 64, height: 48, fps: 8, seed: 'p',
    audio: { mood: 'calm', seed: 'p' },
    scenes: [
      { duration: 1, background: { type: 'solid', color: '#123456' }, layers: [{ type: 'text', text: 'A', x: 4, y: 4, scale: 2 }] },
      { duration: 1, background: { type: 'solid', color: '#654321' }, transitionIn: { type: 'crossfade', duration: 0.4 }, layers: [{ type: 'text', text: 'B', x: 4, y: 4, scale: 2 }] },
    ],
  });
  const out = renderToArtifacts(tl, { format: 'all' });
  assert.ok(out.gif && out.gif.length > 0);
  assert.ok(out.avi && out.avi.length > 0);
  assert.equal(out.pngs.length, 16);
  assert.equal(parseGif(out.gif).frames, 16);
  assert.equal(parseAvi(out.avi).totalFrames, 16);
  assert.equal(out.manifest.formats.length, 3);
  assert.equal(out.manifest.hasAudio, true);
});

test('render: easing functions are monotonic on [0,1]', () => {
  for (const name of ['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeOutCubic']) {
    assert.equal(easing(name, 0), 0);
    assert.ok(Math.abs(easing(name, 1) - 1) < 1e-9);
  }
});

test('render: encoders accept frames directly', () => {
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const c = createCanvas(32, 24, '#000000');
    fillRect(c, i * 4, 4, 8, 8, '#ffffff');
    frames.push(c);
  }
  const gif = framesToGif(frames, { width: 32, height: 24, fps: 10 });
  assert.equal(parseGif(gif).frames, 4);
  const avi = framesToAvi(frames, null, { width: 32, height: 24, fps: 10 });
  assert.equal(parseAvi(avi).totalFrames, 4);
});
