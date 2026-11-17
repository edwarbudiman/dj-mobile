import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AngleTracker,
  DEAD_ZONE,
  MOTOR_TAU,
  REV_SECONDS,
  angleToSeconds,
  applyDelta,
  motorRate,
  pixelsToSeconds,
  pointerAngle,
  positionToAngle,
  wrapAngle,
} from '../js/audio/scratch-math.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('one revolution of the platter is 1.8 s of track time (33 1/3 rpm)', () => {
  close(REV_SECONDS, 1.8);
  close(angleToSeconds(2 * Math.PI), 1.8);
  close(angleToSeconds(-Math.PI / 2), -0.45);
  assert.equal(angleToSeconds(NaN), 0);
  assert.equal(angleToSeconds(Infinity), 0);
});

test('marker angle matches the pointer angle convention (0 = up, clockwise)', () => {
  close(pointerAngle(0, -10), 0);
  close(pointerAngle(10, 0), Math.PI / 2);
  close(pointerAngle(0, 10), Math.PI);
  close(pointerAngle(-10, 0), -Math.PI / 2);
  close(positionToAngle(0.45), Math.PI / 2);
  close(positionToAngle(1.8), 0);
  close(positionToAngle(-0.45), (3 * Math.PI) / 2);
});

test('wrapAngle folds into (-pi, pi]', () => {
  close(wrapAngle(0.1), 0.1);
  close(wrapAngle(2 * Math.PI + 0.1), 0.1);
  close(wrapAngle(-2 * Math.PI - 0.1), -0.1);
  close(wrapAngle(Math.PI + 0.2), -Math.PI + 0.2);
  close(wrapAngle(-Math.PI - 0.2), Math.PI - 0.2);
  assert.equal(wrapAngle(NaN), 0);
});

test('AngleTracker unwraps across the +/-pi seam in both directions', () => {
  const t = new AngleTracker();
  const R = 60;
  const at = (a) => [R * 0.8 * Math.sin(a), -R * 0.8 * Math.cos(a)];
  assert.equal(t.update(...at(Math.PI - 0.1), R), 0); // anchors
  let total = 0;
  for (const a of [Math.PI + 0.05, Math.PI + 0.2, Math.PI + 0.4]) total += t.update(...at(a), R);
  close(total, 0.5, 1e-9); // crossed the seam: +0.5 rad, not -5.8
  total = 0;
  for (const a of [Math.PI + 0.2, Math.PI - 0.1, Math.PI - 0.3]) total += t.update(...at(a), R);
  close(total, -0.7, 1e-9);
});

test('AngleTracker accumulates many revolutions', () => {
  const t = new AngleTracker();
  const R = 50;
  t.update(0, -R * 0.9, R);
  let total = 0;
  for (let i = 1; i <= 360; i++) {
    const a = (i * 10 * Math.PI) / 180;
    total += t.update(R * 0.9 * Math.sin(a), -R * 0.9 * Math.cos(a), R);
  }
  close(total, 10 * 2 * Math.PI, 1e-6); // ten turns
});

test('AngleTracker ignores jitter inside the centre dead zone and re-anchors on exit', () => {
  const t = new AngleTracker(0.15);
  const R = 100;
  t.update(0, -50, R); // anchor at angle 0
  assert.equal(t.update(3, 2, R), 0); // inside 15 px: unstable angle, no delta
  assert.equal(t.update(-4, -1, R), 0);
  // leaving the dead zone on the opposite side: the swing is real finger travel, measured from the last stable angle
  const d = t.update(0, 50, R);
  close(Math.abs(d), Math.PI, 1e-9);
  // not anchored at all yet (started in the dead zone): first stable sample only anchors
  const u = new AngleTracker(0.15);
  assert.equal(u.update(2, 2, R), 0);
  assert.equal(u.update(0, -40, R), 0);
  close(u.update(40, 0, R), Math.PI / 2);
});

test('the dead zone is the drawn label (0.36 R): a swipe on the label produces no angle', () => {
  assert.equal(DEAD_ZONE, 0.36);
  const t = new AngleTracker();
  const R = 64;
  assert.equal(t.update(0, -20, R), 0); // inside 23 px: not anchored
  assert.equal(t.update(14, -12, R), 0); // erratic swipe across the label
  assert.equal(t.update(-15, 10, R), 0);
  assert.equal(t.last, null);
  assert.equal(t.update(0, -30, R), 0); // first sample outside only anchors
  close(t.update(30, 0, R), Math.PI / 2);
});

test('AngleTracker rejects non-finite input and zero radius', () => {
  const t = new AngleTracker();
  assert.equal(t.update(NaN, 5, 50), 0);
  assert.equal(t.update(5, Infinity, 50), 0);
  assert.equal(t.update(20, 20, 0), 0);
  assert.equal(t.last, null);
});

test('waveform drag: the waveform sticks to the finger', () => {
  // dragging right pulls earlier audio under the playhead -> position moves backward
  close(pixelsToSeconds(30, 0.02), -0.6);
  close(pixelsToSeconds(-30, 0.02), 0.6);
  assert.equal(pixelsToSeconds(NaN, 0.02), 0);
  assert.equal(pixelsToSeconds(10, 0), 0);
  assert.equal(pixelsToSeconds(10, null), 0);
  assert.equal(pixelsToSeconds(10, -1), 0);
});

test('applyDelta clamps the running position, so a reversal at an edge moves at once', () => {
  assert.equal(applyDelta(1, 0.5, 0, 10), 1.5);
  assert.equal(applyDelta(9.8, 5, 0, 10), 10);
  assert.equal(applyDelta(10, -0.25, 0, 10), 9.75); // no dead zone after pushing past the end
  assert.equal(applyDelta(0.1, -3, 0, 10), 0);
  assert.equal(applyDelta(2, NaN, 0, 10), 2);
});

test('release motor settles on the play rate: 95 % by ~90 ms, 99 % by ~140 ms', () => {
  close(motorRate(0, 1, 0), 0);
  close(motorRate(3, 1, 0), 3);
  assert.ok(Math.abs(motorRate(0, 1, 0.09) - 1) < 0.06);
  assert.ok(Math.abs(motorRate(0, 1, 0.14) - 1) < 0.012);
  assert.ok(Math.abs(motorRate(-4, 1.04, 0.3) - 1.04) < 0.001); // a backward flick still settles
  assert.equal(motorRate(NaN, 1, 0.1), 0);
  assert.ok(MOTOR_TAU > 0.02 && MOTOR_TAU < 0.05);
});
