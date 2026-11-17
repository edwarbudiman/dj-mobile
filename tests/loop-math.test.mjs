import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOP_BEATS, beatAtOrBefore, inLoop, loopLabel, loopRefusal, planLoop, wrapIntoLoop } from '../js/audio/loop-math.js';
import { HOT_CUE_COUNT, confidentGrid, hotCueTime, sanitizeHotCues } from '../js/audio/cue-math.js';
import { FILTER_DEAD, HP_OFF_HZ, LP_MIN_HZ, Q_FLAT, Q_MAX, filterAmount, filterParams } from '../js/audio/filter-math.js';

const grid = { bpm: 120, offset: 0.1, confidence: 1 }; // beat = 0.5 s

test('beatAtOrBefore: the beat at or before the position, never negative', () => {
  assert.ok(Math.abs(beatAtOrBefore(1.7, grid) - 1.6) < 1e-9);
  assert.ok(Math.abs(beatAtOrBefore(1.6, grid) - 1.6) < 1e-9, 'exactly on a beat stays on it');
  assert.ok(Math.abs(beatAtOrBefore(1.5999999999, grid) - 1.6) < 1e-6, 'float dust below a beat counts as on it');
  assert.ok(Math.abs(beatAtOrBefore(0.3, grid) - 0.1) < 1e-9);
  const early = beatAtOrBefore(0.05, grid); // before the first beat: first beat inside the track
  assert.ok(early >= 0 && Math.abs(early - 0.1) < 1e-9, `${early}`);
});

test('planLoop: starts on the beat before the heard position, lasts beats x period', () => {
  for (const beats of LOOP_BEATS) {
    const r = planLoop({ pos: 10.3, grid, beats, duration: 100 });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'set');
    assert.ok(Math.abs(r.start - 10.1) < 1e-9, `start ${r.start}`);
    assert.ok(Math.abs(r.end - r.start - beats * 0.5) < 1e-9);
    assert.equal(r.beats, beats);
  }
});

test('planLoop: the same size again exits; another size keeps the in-point', () => {
  const active = { start: 10.1, end: 12.1, beats: 4 };
  assert.deepEqual(planLoop({ pos: 11, grid, beats: 4, duration: 100, active }), { ok: true, action: 'exit' });
  const r = planLoop({ pos: 11.4, grid, beats: 2, duration: 100, active });
  assert.equal(r.action, 'set');
  assert.equal(r.start, 10.1);
  assert.ok(Math.abs(r.end - 11.1) < 1e-9);
});

test('planLoop: refusals have a reason and a sentence', () => {
  assert.equal(planLoop({ pos: 5, grid: null, beats: 1, duration: 100 }).reason, 'no-grid');
  assert.equal(planLoop({ pos: 5, grid: { bpm: NaN, offset: 0 }, beats: 1, duration: 100 }).reason, 'no-grid');
  assert.equal(planLoop({ pos: 99.5, grid, beats: 8, duration: 100 }).reason, 'near-end');
  assert.equal(planLoop({ pos: 5, grid: { bpm: 300, offset: 0 }, beats: 0.5, duration: 100 }).ok, true, '0.1 s is fine');
  assert.equal(planLoop({ pos: NaN, grid, beats: 1, duration: 100 }).reason, 'bad');
  for (const r of ['no-grid', 'near-end', 'too-short', 'bad']) assert.ok(loopRefusal(r).length > 10);
});

test('inLoop and wrapIntoLoop', () => {
  const loop = { start: 10, end: 12 };
  assert.equal(inLoop(10, loop), true);
  assert.equal(inLoop(12, loop), false);
  assert.equal(inLoop(9.99, loop), false);
  assert.equal(inLoop(5, null), false);
  assert.ok(Math.abs(wrapIntoLoop(12.5, loop) - 10.5) < 1e-12);
  assert.ok(Math.abs(wrapIntoLoop(17.5, loop) - 11.5) < 1e-12);
  assert.ok(Math.abs(wrapIntoLoop(9.5, loop) - 11.5) < 1e-12);
  assert.equal(loopLabel(0.5), '½');
  assert.equal(loopLabel(8), '8');
});

test('hot cue time snaps to the nearest beat only on a confident grid', () => {
  assert.ok(Math.abs(hotCueTime(10.26, grid, 100) - 10.1) < 1e-9 || Math.abs(hotCueTime(10.26, grid, 100) - 10.6) < 1e-9);
  assert.ok(Math.abs(hotCueTime(10.4, grid, 100) - 10.6) < 1e-9);
  assert.equal(hotCueTime(10.4, null, 100), 10.4, 'no grid: exact');
  assert.equal(hotCueTime(10.4, { ...grid, confidence: 0.2 }, 100), 10.4, 'a low-confidence grid is a guess: exact');
  assert.equal(hotCueTime(-3, grid, 100) >= 0, true);
  assert.equal(hotCueTime(NaN, null, 100), 0);
  assert.equal(hotCueTime(500, null, 100), 100, 'clamped into the track');
  assert.equal(confidentGrid({ bpm: 120, offset: 0 }), true, 'a grid without confidence is manual');
  assert.equal(confidentGrid(null), false);
});

test('sanitizeHotCues returns exactly four entries and drops anything unusable', () => {
  assert.deepEqual(sanitizeHotCues(undefined), [null, null, null, null]);
  assert.deepEqual(sanitizeHotCues('x'), [null, null, null, null]);
  assert.deepEqual(sanitizeHotCues([1, null, NaN, 'a', 99]), [1, null, null, null]);
  assert.deepEqual(sanitizeHotCues([1, 2, 3, 4, 5, 6], 3.5), [1, 2, 3, null], 'past the end of the track is dropped');
  assert.deepEqual(sanitizeHotCues([-1, 2], 10), [null, 2, null, null]);
  assert.equal(sanitizeHotCues([]).length, HOT_CUE_COUNT);
});

test('filter: the centre dead zone is fully bypassed', () => {
  for (const pos of [0.5, 0.5 + FILTER_DEAD, 0.5 - FILTER_DEAD, 0.47, 0.53]) {
    const f = filterParams(pos, 22050);
    assert.equal(f.active, false, `pos ${pos}`);
    assert.equal(f.lpHz, 22050, 'low-pass at Nyquist = pass-through');
    assert.equal(f.hpHz, HP_OFF_HZ);
    assert.equal(f.lpQ, Q_FLAT);
    assert.equal(f.hpQ, Q_FLAT);
  }
  assert.equal(filterAmount(NaN), 0);
  assert.equal(filterAmount(undefined), 0);
});

test('filter: left sweeps a low-pass down, right sweeps a high-pass up, both monotonic and continuous', () => {
  let prev = Infinity;
  for (let p = 0.5 - FILTER_DEAD; p >= 0; p -= 0.01) {
    const f = filterParams(p, 22050);
    assert.ok(f.lpHz <= prev + 1e-9, `lp falls at ${p}`);
    assert.equal(f.hpHz, HP_OFF_HZ, 'only one side acts at a time');
    prev = f.lpHz;
  }
  assert.ok(Math.abs(filterParams(0, 22050).lpHz - LP_MIN_HZ) < 1e-6);
  assert.ok(filterParams(0.5 - FILTER_DEAD - 0.001, 22050).lpHz > 20000, 'starts at the top: no jump leaving the dead zone');
  prev = 0;
  for (let p = 0.5 + FILTER_DEAD; p <= 1.0001; p += 0.01) {
    const f = filterParams(p, 22050);
    assert.ok(f.hpHz >= prev - 1e-9, `hp rises at ${p}`);
    assert.equal(f.lpHz, 22050);
    prev = f.hpHz;
  }
  assert.ok(filterParams(1, 22050).hpHz > 5000 && filterParams(1, 22050).hpHz <= 7000 + 1e-6);
  assert.ok(filterParams(0.001, 24000).lpHz < 200);
});

test('filter: Q is in dB (Web Audio): flat -3.01 at the dead-zone edge, +4.5 at full sweep, only on the active side', () => {
  assert.ok(Math.abs(Q_FLAT - -3.01) < 1e-9, 'Butterworth-flat is -3.01 dB, not linear 0.707');
  assert.ok(Math.abs(Q_MAX - 4.5) < 1e-9);
  for (let p = 0; p <= 1; p += 0.02) {
    const f = filterParams(p);
    assert.ok(f.lpQ >= Q_FLAT - 1e-9 && f.lpQ <= Q_MAX + 1e-9);
    assert.ok(f.hpQ >= Q_FLAT - 1e-9 && f.hpQ <= Q_MAX + 1e-9);
  }
  assert.ok(Math.abs(filterParams(0).lpQ - Q_MAX) < 1e-9);
  assert.ok(Math.abs(filterParams(1).hpQ - Q_MAX) < 1e-9);
  assert.equal(filterParams(0).hpQ, Q_FLAT);
  assert.ok(Math.abs(filterParams(0.5 - 0.04 - 0.001).lpQ - Q_FLAT) < 0.01, 'flat at the edge of the dead zone');
  assert.ok(Q_MAX <= 5, 'tame: at most about +5 dB of resonant peak');
});
