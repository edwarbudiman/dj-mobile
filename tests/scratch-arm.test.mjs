import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARM_HOLD_MS, ARM_MOVE_PX, armHold, armMove, armStart, armUp } from '../js/ui/scratch-arm.js';

const GEO = { cx: 100, cy: 100 };

test('portrait hold-to-grab is about 250 ms', () => {
  assert.equal(ARM_HOLD_MS, 250);
});

test('a hold engages on the platter but never on the waveform', () => {
  assert.equal(armHold(armStart('platter', 140, 100, GEO)), 'engage');
  const wave = armStart('wave', 50, 50);
  assert.equal(armHold(wave), 'pending'); // hold alone: still armed, waiting for sideways movement
  assert.equal(armMove(wave, 50 + ARM_MOVE_PX + 5, 52), 'engage'); // ...which then grabs
});

test('waveform: horizontal movement engages, a vertical swipe is left to scroll', () => {
  assert.equal(armMove(armStart('wave', 50, 50), 53, 51), 'pending'); // under the threshold
  assert.equal(armMove(armStart('wave', 50, 50), 70, 55), 'engage');
  assert.equal(armMove(armStart('wave', 50, 50), 54, 80), 'cancel');
  assert.equal(armMove(armStart('wave', 50, 50), 58, 70), 'cancel'); // steeper than 1.5:1
  assert.equal(armMove(armStart('wave', 50, 50), 65, 65), 'engage'); // 45 degrees: scratch-like
});

test('platter: around the vinyl engages, along a radius or straight up/down does not', () => {
  // finger at 12 o'clock of the vinyl (100, 60): moving sideways is tangential
  assert.equal(armMove(armStart('platter', 100, 60, GEO), 120, 62), 'engage');
  // moving straight down toward the centre is radial (and vertical)
  assert.equal(armMove(armStart('platter', 100, 60, GEO), 101, 80), 'cancel');
  // finger at 3 o'clock (140, 100): moving sideways is radial -> left alone
  assert.equal(armMove(armStart('platter', 140, 100, GEO), 160, 101), 'cancel');
  // finger at 3 o'clock moving vertically: tangential but a vertical swipe -> scroll
  assert.equal(armMove(armStart('platter', 140, 100, GEO), 141, 125), 'cancel');
});

test('the pointer ending disarms for good: a late hold timer or move never grabs (stuck-grab regression)', () => {
  for (const kind of ['platter', 'wave']) {
    const a = armStart(kind, 100, 60, GEO);
    armUp(a); // pointerup / pointercancel / lostpointercapture, wherever it happened
    assert.equal(armHold(a), 'cancel');
    assert.equal(armMove(a, 140, 62), 'cancel');
  }
});

test('non-finite coordinates never decide anything', () => {
  const a = armStart('wave', 50, 50);
  assert.equal(armMove(a, NaN, 50), 'pending');
  assert.equal(armMove(a, 80, Infinity), 'pending');
  assert.equal(armMove(a, 80, 52), 'engage');
});
