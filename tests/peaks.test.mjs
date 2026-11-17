import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PEAK_BASE, buildPeaks, downmixDecimate, downmixDecimateAsync, getColumns, levelFor } from '../js/audio/peaks.js';

const noYield = () => Promise.resolve();

function ramp(n) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = (i / n) * 2 - 1;
  return a;
}

test('level 0 min/max/rms match a direct computation', async () => {
  const left = ramp(PEAK_BASE * 10);
  const p = await buildPeaks(left, null, 44100, { yieldFn: noYield });
  const l0 = p.levels[0];
  assert.equal(l0.count, 10);
  for (let b = 0; b < 10; b++) {
    const seg = left.subarray(b * PEAK_BASE, (b + 1) * PEAK_BASE);
    assert.equal(l0.min[b], Math.min(...seg));
    assert.equal(l0.max[b], Math.max(...seg));
    const rms = Math.sqrt(seg.reduce((s, v) => s + v * v, 0) / seg.length);
    assert.ok(Math.abs(l0.rms[b] - rms) < 1e-5);
  }
});

test('stereo peaks take the union of both channels', async () => {
  const left = new Float32Array(PEAK_BASE).fill(0.25);
  const right = new Float32Array(PEAK_BASE).fill(-0.5);
  const p = await buildPeaks(left, right, 44100, { yieldFn: noYield });
  assert.equal(p.levels[0].min[0], -0.5);
  assert.equal(p.levels[0].max[0], 0.25);
});

test('chunked (time-sliced) result equals the single-slice result and actually yields', async () => {
  const left = ramp(PEAK_BASE * 100 + 37);
  let yields = 0;
  const sliced = await buildPeaks(left, null, 44100, { sliceFrames: PEAK_BASE * 8, yieldFn: async () => void yields++ });
  const whole = await buildPeaks(left, null, 44100, { sliceFrames: 1 << 30, yieldFn: noYield });
  assert.ok(yields >= 10, `yielded ${yields} times`);
  assert.deepEqual(sliced.levels[0].min, whole.levels[0].min);
  assert.deepEqual(sliced.levels[0].max, whole.levels[0].max);
  assert.equal(sliced.levels.length, whole.levels.length);
});

test('coarser levels cover the same range', async () => {
  const left = ramp(PEAK_BASE * 4096);
  const p = await buildPeaks(left, null, 44100, { yieldFn: noYield });
  assert.ok(p.levels.length > 3);
  for (const lv of p.levels) {
    assert.equal(Math.min(...lv.min), -1);
    assert.ok(Math.max(...lv.max) > 0.999);
  }
  assert.ok(p.levels[1].size === p.levels[0].size * 4);
});

test('abort returns null', async () => {
  const left = ramp(PEAK_BASE * 100);
  const p = await buildPeaks(left, null, 44100, { sliceFrames: PEAK_BASE * 4, yieldFn: noYield, shouldAbort: () => true });
  assert.equal(p, null);
});

test('getColumns: whole-track columns cover the global range; out-of-range columns are zero', async () => {
  const left = ramp(PEAK_BASE * 1000);
  const p = await buildPeaks(left, null, 44100, { yieldFn: noYield });
  const n = 100;
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  getColumns(p, 0, p.length / n, n, min, max);
  assert.ok(min[0] <= -0.99 && max[n - 1] >= 0.99);
  for (let i = 1; i < n; i++) assert.ok(max[i] >= max[i - 1] - 1e-6, 'monotone ramp');
  getColumns(p, -2 * PEAK_BASE * 10, PEAK_BASE, 10, min, max);
  assert.ok(min.subarray(0, 10).every((v) => v === 0) && max.subarray(0, 10).every((v) => v === 0));
  getColumns(p, p.length + 5, PEAK_BASE, 10, min, max);
  assert.ok(max.subarray(0, 10).every((v) => v === 0));
});

test('levelFor picks the coarsest level not exceeding frames-per-pixel', async () => {
  const p = await buildPeaks(ramp(PEAK_BASE * 4096), null, 44100, { yieldFn: noYield });
  assert.equal(levelFor(p, 10), 0);
  assert.equal(levelFor(p, PEAK_BASE * 4), 1);
  assert.equal(levelFor(p, PEAK_BASE * 4 - 1), 0);
});

test('a 10 minute track is processed in many short slices', async () => {
  const frames = 44100 * 600;
  const left = new Float32Array(frames);
  let yields = 0;
  const p = await buildPeaks(left, null, 44100, { yieldFn: async () => void yields++ });
  assert.ok(yields >= 40, `only ${yields} yields`);
  assert.equal(p.levels[0].count, Math.ceil(frames / PEAK_BASE));
});

test('downmixDecimate averages channels and decimates', async () => {
  const l = new Float32Array([1, 1, 1, 1, 0, 0, 0, 0]);
  const r = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]);
  const out = downmixDecimate(l, r, 0, 8, 4);
  assert.deepEqual([...out], [0.5, 0]);
  const asyncOut = await downmixDecimateAsync(l, r, 0, 8, 4, { yieldFn: noYield });
  assert.deepEqual([...asyncOut], [...out]);
  assert.equal(await downmixDecimateAsync(l, r, 0, 8, 4, { shouldAbort: () => true, yieldFn: noYield }), null);
});
