import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTapTracker, isTap } from '../js/ui/tap.js';

const tap = (tr, t0, x, y, hold = 80) => {
  tr.down(t0, x, y);
  return tr.up(t0 + hold, x, y);
};

test('a short stationary touch is a tap; a drag or a long press is not', () => {
  assert.equal(isTap({ t: 0, x: 0, y: 0 }, { t: 100, x: 2, y: 2 }), true);
  assert.equal(isTap({ t: 0, x: 0, y: 0 }, { t: 100, x: 0, y: 8 }), false, 'moved >= 6 px');
  assert.equal(isTap({ t: 0, x: 0, y: 0 }, { t: 300, x: 0, y: 0 }), false, 'longer than 250 ms');
  assert.equal(isTap({ t: 0, x: 0, y: 0 }, { t: 100, x: 0, y: 0 }, 9), false, 'moved away and came back');
});

test('two quick taps at the same spot are a double tap, a third starts over', () => {
  const tr = createTapTracker();
  assert.equal(tap(tr, 1000, 50, 50), 'tap');
  assert.equal(tap(tr, 1200, 52, 51), 'double');
  assert.equal(tap(tr, 1400, 50, 50), 'tap', 'the double consumed both taps');
});

test('two quick DRAG strokes never count as a double tap', () => {
  const tr = createTapTracker();
  for (const t0 of [1000, 1200]) {
    tr.down(t0, 20, 100);
    tr.move(20, 80);
    tr.move(20, 40);
    assert.equal(tr.up(t0 + 100, 20, 40), 'none');
  }
});

test('a drag between two taps breaks the double tap', () => {
  const tr = createTapTracker();
  assert.equal(tap(tr, 1000, 10, 10), 'tap');
  tr.down(1100, 10, 10);
  tr.move(10, 60);
  tr.up(1180, 10, 60);
  assert.equal(tap(tr, 1250, 10, 10), 'tap');
});

test('taps too far apart in time or space are not a double tap', () => {
  let tr = createTapTracker();
  assert.equal(tap(tr, 1000, 0, 0), 'tap');
  assert.equal(tap(tr, 1000 + 80 + 400, 0, 0), 'tap', 'gap longer than 320 ms');
  tr = createTapTracker();
  assert.equal(tap(tr, 1000, 0, 0), 'tap');
  assert.equal(tap(tr, 1200, 40, 0), 'tap', 'more than 24 px apart');
});

test('a slow press (a hold) is not a tap even if stationary', () => {
  const tr = createTapTracker();
  tr.down(0, 5, 5);
  assert.equal(tr.up(600, 5, 5), 'none');
});

test('cancel clears everything', () => {
  const tr = createTapTracker();
  assert.equal(tap(tr, 1000, 5, 5), 'tap');
  tr.cancel();
  assert.equal(tap(tr, 1150, 5, 5), 'tap');
  tr.down(2000, 0, 0);
  tr.cancel();
  assert.equal(tr.up(2050, 0, 0), 'none');
});
