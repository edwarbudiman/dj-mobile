import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beatPosition, beatsInRange, effectiveBpm, faderToPitch, nearestBeatTime, phaseAlignDelta,
  pitchToFader, planSync, retempo, shiftGrid, tapTempo,
} from '../js/audio/sync-math.js';
import { clamp, crossfaderGains, eqPositionToDb, faderToGain } from '../js/audio/mixer-math.js';
import { estimatePosition } from '../js/audio/playhead-math.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test('effective BPM = base x pitch', () => {
  near(effectiveBpm(120, 8), 129.6);
  near(effectiveBpm(120, -8), 110.4);
  assert.equal(effectiveBpm(null, 0), null);
  assert.equal(effectiveBpm(0, 0), null);
});

test('pitch fader follows hardware convention (down = faster) and is invertible', () => {
  near(faderToPitch(0.5, 8), 0);
  near(faderToPitch(0, 8), 8, 1e-9); // fader at the bottom: +8 %
  near(faderToPitch(1, 16), -16); // fader at the top: -16 %
  near(pitchToFader(faderToPitch(0.73, 16), 16), 0.73);
  assert.equal(pitchToFader(99, 8), 0);
  assert.equal(faderToPitch(NaN, 8), 0);
  // fine values stay reachable: 0.31 % on the +/-8 % range is a 0.019 fader step
  near(faderToPitch(pitchToFader(0.31, 8), 8), 0.31, 1e-9);
});

test('beat position, nearest beat and beat range', () => {
  const g = { bpm: 120, offset: 0.1 };
  const p = beatPosition(0.1 + 0.5 * 5 + 0.25, g);
  assert.equal(p.beat, 5);
  near(p.phase, 0.5);
  assert.equal(p.bar, 1);
  near(nearestBeatTime(1.0, g), 1.1);
  const beats = beatsInRange(g, 0, 2.2);
  assert.deepEqual(beats.map((b) => b.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(beats.map((b) => b.downbeat), [true, false, false, false, true]);
  assert.equal(beatPosition(0, g).bar, 3, 'negative beats wrap to the bar');
});

test('retempo keeps the beat nearest the anchor in place', () => {
  const g = { bpm: 100, offset: 0.2, confidence: 0.9, source: 'auto' };
  const anchor = 30.0;
  const before = nearestBeatTime(anchor, g);
  const g2 = retempo(g, 200, anchor);
  assert.equal(g2.bpm, 200);
  assert.equal(g2.source, 'auto');
  near(nearestBeatTime(before, g2), before, 1e-6);
  assert.ok(g2.offset >= 0 && g2.offset < 0.3);
  assert.equal(retempo(g, 9999, 0).bpm, 300, 'clamped');
  assert.equal(retempo(g, 1, 0).bpm, 20, 'clamped');
});

test('x2 and /2 keep existing beats on the grid', () => {
  const g = { bpm: 90, offset: 0.37 };
  const onBeat = (t, grid) => {
    const ph = beatPosition(t, grid).phase;
    return Math.min(ph, 1 - ph) < 1e-6;
  };
  const beatT = nearestBeatTime(10, g);
  assert.ok(onBeat(beatT, retempo(g, 180, 10)));
  assert.ok(onBeat(beatT, retempo(g, 45, 10)));
});

test('shiftGrid moves the offset and wraps within one beat', () => {
  const g = { bpm: 120, offset: 0.005 };
  near(shiftGrid(g, 0.01).offset, 0.015);
  near(shiftGrid(g, -0.01).offset, 0.495);
});

test('tapTempo: moving track uses track-time intervals and sets phase', () => {
  const taps = [0, 1, 2, 3].map((i) => ({ pos: 10.3 + i * 0.5, t: i * 0.45 })); // track beats every 0.5 s
  const r = tapTempo(taps, true);
  near(r.bpm, 120, 1e-6);
  near(r.offset, 0.3, 1e-6);
});

test('tapTempo: stopped track uses wall time', () => {
  const taps = [0, 0.5, 1.0, 1.5].map((t) => ({ pos: 4.2, t }));
  const r = tapTempo(taps, false);
  near(r.bpm, 120, 1e-6);
  near(r.offset, 4.2 % 0.5, 1e-6);
});

test('tapTempo needs two usable taps', () => {
  assert.equal(tapTempo([{ pos: 1, t: 1 }], true), null);
  assert.equal(tapTempo([], true), null);
  assert.equal(tapTempo([{ pos: 1, t: 1 }, { pos: 1, t: 1 }], true), null);
});

test('planSync: nearest of x1, x2, x0.5, with range widening', () => {
  let r = planSync({ thisBase: 120, otherEff: 124 });
  assert.ok(r.ok && r.ratio === 1 && r.range === 8);
  near(r.pitch, (124 / 120 - 1) * 100);
  r = planSync({ thisBase: 64, otherEff: 128 }); // 64 vs 128: exactly x1 off by 100 %, x0.5 -> 0 %
  assert.ok(r.ok && r.ratio === 0.5);
  near(r.pitch, 0);
  r = planSync({ thisBase: 130, otherEff: 64.5 }); // x2 -> 129, -0.77 %
  assert.ok(r.ok && r.ratio === 2);
  r = planSync({ thisBase: 120, otherEff: 134 }); // +11.7 %: needs the 16 % range
  assert.ok(r.ok && r.range === 16);
  r = planSync({ thisBase: 100, otherEff: 150 }); // x1 +50 %, x0.5 -25 % ...  none within 16 %
  assert.equal(r.ok, false);
  assert.equal(planSync({ thisBase: null, otherEff: 120 }).reason, 'unknown-bpm');
  assert.equal(planSync({ thisBase: 120, otherEff: NaN }).ok, false);
});

test('phaseAlignDelta lands on the other deck\'s beat phase (at most half a beat)', () => {
  const a = { bpm: 120, offset: 0 };
  const b = { bpm: 120, offset: 0.13 };
  const thisPos = 20.05;
  const otherPos = 31.31;
  const d = phaseAlignDelta({ thisPos, thisGrid: a, otherPos, otherGrid: b });
  assert.ok(Math.abs(d) <= 0.25 + 1e-9);
  near(beatPosition(thisPos + d, a).phase % 1, beatPosition(otherPos, b).phase, 1e-6);
});

test('phaseAlignDelta with a 2x relationship', () => {
  const a = { bpm: 128, offset: 0 };
  const b = { bpm: 64, offset: 0 };
  const d = phaseAlignDelta({ thisPos: 10.1, thisGrid: a, otherPos: 20.3, otherGrid: b, ratio: 2 });
  const target = (beatPosition(20.3, b).phase * 2) % 1;
  near(beatPosition(10.1 + d, a).phase, target, 1e-6);
});

test('crossfader is equal-power with exact endpoints', () => {
  assert.deepEqual(crossfaderGains(0), { a: 1, b: 0 });
  assert.deepEqual(crossfaderGains(1), { a: 0, b: 1 });
  for (let x = 0; x <= 1; x += 0.05) {
    const { a, b } = crossfaderGains(x);
    near(a * a + b * b, 1, 1e-12);
  }
  near(crossfaderGains(0.5).a, Math.SQRT1_2);
  assert.deepEqual(crossfaderGains(NaN), { a: 1, b: 0 });
});

test('EQ and fader tapers', () => {
  near(eqPositionToDb(0), -26);
  near(eqPositionToDb(0.8), 0);
  near(eqPositionToDb(1), 6);
  near(faderToGain(0.8), 1);
  assert.equal(faderToGain(0), 0);
  assert.ok(faderToGain(1) > 1);
  assert.ok(Number.isFinite(eqPositionToDb(NaN)) && Number.isFinite(faderToGain(NaN)));
});

test('clamp is NaN-safe and estimatePosition stays in range', () => {
  assert.equal(clamp(NaN, 0, 1), 0);
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(estimatePosition({ pos: 1, ctxTime: 0, speed: 1 }, 2, 10), 3);
  assert.equal(estimatePosition({ pos: 9.5, ctxTime: 0, speed: 1 }, 5, 10), 10);
  assert.equal(estimatePosition({ pos: 1, ctxTime: 0, speed: -1 }, 5, 10), 0);
  assert.equal(estimatePosition({ pos: NaN, ctxTime: 0, speed: 1 }, 5, 10), 0);
  assert.equal(estimatePosition(null, 5, 10), 0);
});
