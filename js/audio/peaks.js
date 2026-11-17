// Waveform peak extraction (pure: no DOM, no Web Audio; runs in Node and browsers).
//
// buildPeaks() makes a multi-resolution min/max/RMS pyramid. It is time-sliced: it processes a
// bounded number of frames, then yields to the event loop, so a 10 minute track never freezes
// the UI. Level 0 has one bucket per PEAK_BASE frames; each further level is 4x coarser.

export const PEAK_BASE = 256;
const LEVEL_FACTOR = 4;
const SLICE_FRAMES = PEAK_BASE * 2048; // ~524k frames per slice

/** Yield to the event loop. MessageChannel is not throttled in background tabs, unlike timers. */
export function yieldToEventLoop() {
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fillLevel0(left, right, level, fromBucket, toBucket) {
  const { min, max, rms } = level;
  const length = left.length;
  for (let b = fromBucket; b < toBucket; b++) {
    const s = b * PEAK_BASE;
    const e = Math.min(length, s + PEAK_BASE);
    let lo = Infinity;
    let hi = -Infinity;
    let sq = 0;
    if (right === left) {
      for (let i = s; i < e; i++) {
        const v = left[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sq += v * v;
      }
    } else {
      for (let i = s; i < e; i++) {
        const a = left[i];
        const c = right[i];
        const l = a < c ? a : c;
        const h = a > c ? a : c;
        if (l < lo) lo = l;
        if (h > hi) hi = h;
        sq += (a * a + c * c) * 0.5;
      }
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = Math.sqrt(sq / (e - s));
  }
}

function reduceLevel(src, size) {
  const count = Math.ceil(src.count / LEVEL_FACTOR);
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const rms = new Float32Array(count);
  for (let b = 0; b < count; b++) {
    const s = b * LEVEL_FACTOR;
    const e = Math.min(src.count, s + LEVEL_FACTOR);
    let lo = Infinity;
    let hi = -Infinity;
    let sq = 0;
    for (let i = s; i < e; i++) {
      if (src.min[i] < lo) lo = src.min[i];
      if (src.max[i] > hi) hi = src.max[i];
      sq += src.rms[i] * src.rms[i];
    }
    min[b] = lo;
    max[b] = hi;
    rms[b] = Math.sqrt(sq / (e - s));
  }
  return { size, count, min, max, rms };
}

/**
 * @param {Float32Array} left
 * @param {Float32Array|null} right  null/undefined for mono
 * @param {number} sampleRate
 * @param {{yieldFn?:()=>Promise<void>, shouldAbort?:()=>boolean, sliceFrames?:number}} [opts]
 * @returns {Promise<null|{sampleRate:number, length:number, levels:{size:number,count:number,min:Float32Array,max:Float32Array,rms:Float32Array}[]}>}
 *          null if aborted
 */
export async function buildPeaks(left, right, sampleRate, opts = {}) {
  const yieldFn = opts.yieldFn || yieldToEventLoop;
  const slice = Math.max(PEAK_BASE, Math.floor((opts.sliceFrames || SLICE_FRAMES) / PEAK_BASE) * PEAK_BASE);
  const length = left.length;
  const r = right || left;
  const count = Math.ceil(length / PEAK_BASE);
  const level0 = { size: PEAK_BASE, count, min: new Float32Array(count), max: new Float32Array(count), rms: new Float32Array(count) };

  for (let s = 0; s < length; s += slice) {
    if (opts.shouldAbort && opts.shouldAbort()) return null;
    fillLevel0(left, r, level0, s / PEAK_BASE, Math.min(count, (s + slice) / PEAK_BASE));
    if (s + slice < length) await yieldFn();
  }
  if (opts.shouldAbort && opts.shouldAbort()) return null;

  const levels = [level0];
  while (levels[levels.length - 1].count > 16) {
    const prev = levels[levels.length - 1];
    levels.push(reduceLevel(prev, prev.size * LEVEL_FACTOR));
  }
  return { sampleRate, length, levels };
}

/** Index of the coarsest level whose bucket size does not exceed framesPerPixel. */
export function levelFor(peaks, framesPerPixel) {
  let k = 0;
  for (let i = 1; i < peaks.levels.length; i++) {
    if (peaks.levels[i].size <= framesPerPixel) k = i;
    else break;
  }
  return k;
}

/**
 * Fill outMin/outMax (and outRms if given) with n columns, each covering framesPerPixel frames,
 * starting at startFrame (may be negative or run past the end: those columns are 0).
 * Returns the number of columns that contain audio. `forceLevel` pins the pyramid level (the
 * zoomed view uses level 0 so every column covers a whole number of buckets).
 */
export function getColumns(peaks, startFrame, framesPerPixel, n, outMin, outMax, outRms, forceLevel) {
  const level = peaks.levels[forceLevel !== undefined ? Math.min(forceLevel, peaks.levels.length - 1) : levelFor(peaks, framesPerPixel)];
  let filled = 0;
  for (let c = 0; c < n; c++) {
    const f0 = startFrame + c * framesPerPixel;
    const f1 = f0 + framesPerPixel;
    if (!(f1 > 0) || f0 >= peaks.length) {
      outMin[c] = outMax[c] = 0;
      if (outRms) outRms[c] = 0;
      continue;
    }
    let b0 = Math.floor(Math.max(0, f0) / level.size);
    let b1 = Math.max(b0 + 1, Math.ceil(Math.min(f1, peaks.length) / level.size));
    if (b1 > level.count) b1 = level.count;
    if (b0 >= b1) b0 = b1 - 1;
    let lo = Infinity;
    let hi = -Infinity;
    let sq = 0;
    for (let b = b0; b < b1; b++) {
      if (level.min[b] < lo) lo = level.min[b];
      if (level.max[b] > hi) hi = level.max[b];
      sq += level.rms[b] * level.rms[b];
    }
    outMin[c] = lo;
    outMax[c] = hi;
    if (outRms) outRms[c] = Math.sqrt(sq / (b1 - b0));
    filled++;
  }
  return filled;
}

/** Average left/right down to mono and decimate by an integer factor (box filter). Sync. */
export function downmixDecimate(left, right, startFrame, endFrame, factor) {
  const f = Math.max(1, Math.floor(factor));
  const s = Math.max(0, Math.floor(startFrame));
  const e = Math.min(left.length, Math.floor(endFrame));
  const n = Math.max(0, Math.floor((e - s) / f));
  const out = new Float32Array(n);
  const stereo = right && right !== left;
  for (let k = 0; k < n; k++) {
    let sum = 0;
    const base = s + k * f;
    if (stereo) for (let j = 0; j < f; j++) sum += left[base + j] + right[base + j];
    else for (let j = 0; j < f; j++) sum += left[base + j] * 2;
    out[k] = sum / (2 * f);
  }
  return out;
}

/** Time-sliced downmixDecimate. Returns null if aborted. */
export async function downmixDecimateAsync(left, right, startFrame, endFrame, factor, opts = {}) {
  const yieldFn = opts.yieldFn || yieldToEventLoop;
  const f = Math.max(1, Math.floor(factor));
  const total = Math.max(0, Math.floor((Math.min(left.length, endFrame) - Math.max(0, startFrame)) / f));
  const out = new Float32Array(total);
  const chunk = 1 << 17; // output samples per slice
  for (let k = 0; k < total; k += chunk) {
    if (opts.shouldAbort && opts.shouldAbort()) return null;
    const from = Math.max(0, startFrame) + k * f;
    const part = downmixDecimate(left, right, from, from + Math.min(chunk, total - k) * f, f);
    out.set(part, k);
    if (k + chunk < total) await yieldFn();
  }
  return out;
}
