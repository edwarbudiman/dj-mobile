// Loops in js/audio/deck-processor.js under a stubbed AudioWorkletGlobalScope.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SR = 48000;
const posted = [];
let registered = null;
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { onmessage: null, postMessage: (m) => posted.push(m) };
  }
};
globalThis.registerProcessor = (name, cls) => {
  registered = cls;
};
await import('../js/audio/deck-processor.js');

const BLOCK = 128 / SR;
const SLOPE = 0.5 * 2 * Math.PI * 440 / SR; // steepest step of a 440 Hz sine at amplitude 0.5: 0.0288

function sine(freq, seconds, amp = 0.5) {
  const a = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}
function makeProc(left, right = null) {
  const p = new registered();
  p.port.onmessage({ data: { type: 'load', left, right, sampleRate: SR } });
  return p;
}
const send = (p, m) => p.port.onmessage({ data: m });
function render(p, blocks) {
  const out = new Float32Array(blocks * 128);
  for (let b = 0; b < blocks; b++) {
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    p.process([], [[L, R]]);
    out.set(L, b * 128);
    globalThis.currentTime += BLOCK;
  }
  return out;
}
function maxStep(a, from = 1) {
  let m = 0;
  for (let i = Math.max(1, from); i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
}
const allFinite = (a) => a.every(Number.isFinite);

test('loop: the seam has no step larger than the source\'s own slope (a hard cut would be ~0.5)', () => {
  const start = 1.0;
  const end = 1.5006; // not a whole number of 440 Hz periods: a hard cut would jump by ~0.5
  const x = (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t);
  assert.ok(Math.abs(x(end) - x(start)) > 0.4, 'the test seam is a bad one');
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 0.9 });
  render(p, 10); // the seek lands (a seek made after the loop is set, outside it, would drop it)
  send(p, { type: 'loop', on: true, start, end });
  assert.equal(p.loopOn, true);
  send(p, { type: 'play' });
  const out = render(p, 1500); // 4 s: about 7 wraps
  assert.ok(allFinite(out));
  assert.ok(p.pos / SR >= start && p.pos / SR < end + 1e-6, `pos ${p.pos / SR} stays in the loop`);
  const step = maxStep(out);
  assert.ok(step < SLOPE + 0.004, `max step ${step} (source slope ${SLOPE})`);
  assert.ok(out.reduce((m, v) => Math.max(m, v), 0) > 0.4, 'audible');
});

test('loop: length is exact over 100 repeats (no drift), at a fractional length in frames', () => {
  const dc = new Float32Array(SR * 60).fill(0.5);
  const p = makeProc(dc);
  const start = 1.0;
  const end = 1.4918; // 23606.4 frames
  send(p, { type: 'loop', on: true, start, end });
  send(p, { type: 'play' });
  const blocks = 18900; // 2.42 M frames: 100+ repeats
  render(p, blocks);
  const F = blocks * 128;
  const L = p.loopLen;
  assert.ok(Math.abs(L - 0.4918 * SR) < 1e-6);
  const expected = start * SR + ((F - start * SR) % L);
  assert.ok(Math.abs(p.pos - expected) < 1e-6, `pos ${p.pos} expected ${expected}`);
  const wraps = (F - p.pos) / L;
  assert.ok(Math.abs(wraps - Math.round(wraps)) < 1e-6 && Math.round(wraps) >= 100, `wraps ${wraps}`);
});

test('loop exit: playback continues past the old loop end, seamlessly', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5006 });
  send(p, { type: 'seek', time: 1.1 });
  send(p, { type: 'play' });
  const a = render(p, 200); // inside the loop
  send(p, { type: 'loop', on: false });
  const before = p.pos;
  const b = render(p, 1);
  assert.ok(Math.abs(p.pos - before - 128) < 1e-9, 'advances straight on');
  const c = render(p, 400); // 0.5 s: crosses the old end
  assert.ok(p.pos / SR > 1.65, `pos ${p.pos / SR} carried on past 1.5006`);
  const all = new Float32Array(a.length + b.length + c.length);
  all.set(a);
  all.set(b, a.length);
  all.set(c, a.length + b.length);
  assert.ok(maxStep(all) < SLOPE + 0.004, `max step ${maxStep(all)}`);
  assert.equal(p.loopOn, false);
});

test('loop exit during the seam crossfade is also click-free', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5006 });
  send(p, { type: 'seek', time: 1.49 });
  send(p, { type: 'play' });
  const parts = [];
  for (let i = 0; i < 80 && p.loopXfLeft === 0; i++) parts.push(render(p, 1));
  assert.ok(p.loopXfLeft > 0, 'inside a seam crossfade');
  send(p, { type: 'loop', on: false });
  parts.push(render(p, 100));
  const all = new Float32Array(parts.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of parts) {
    all.set(a, o);
    o += a.length;
  }
  assert.ok(maxStep(all) < SLOPE + 0.004, `max step ${maxStep(all)}`);
});

test('loop: a pitch change keeps the loop (in track time) and does not click', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5006 });
  send(p, { type: 'seek', time: 1.1 });
  send(p, { type: 'play' });
  render(p, 100);
  send(p, { type: 'rate', value: 1.1 });
  const a = render(p, 600);
  send(p, { type: 'rate', value: 0.92 });
  const b = render(p, 600);
  const all = new Float32Array(a.length + b.length);
  all.set(a);
  all.set(b, a.length);
  assert.ok(allFinite(all));
  assert.ok(p.pos / SR >= 1.0 && p.pos / SR < 1.5006 + 1e-6, `pos ${p.pos / SR}`);
  assert.ok(maxStep(all) < SLOPE * 1.12 + 0.004, `max step ${maxStep(all)}`);
  assert.ok(Math.abs(p.loopLen - (1.5006 - 1.0) * SR) < 1e-6, 'the loop length did not change with the pitch');
});

test('loop: reverse playback wraps from the start back to the end', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5006 });
  send(p, { type: 'seek', time: 1.2 });
  send(p, { type: 'rate', value: -1 });
  p.rate = -1;
  send(p, { type: 'play' });
  const out = render(p, 800);
  assert.ok(allFinite(out));
  assert.ok(p.pos / SR >= 1.0 && p.pos / SR <= 1.5006 + 1e-6, `pos ${p.pos / SR}`);
  assert.ok(maxStep(out) < SLOPE + 0.004, `max step ${maxStep(out)}`);
});

test('loop: scratching suspends it; letting go outside drops it, letting go inside keeps it', () => {
  // grab, drag past the loop end, release while playing -> dropped
  posted.length = 0;
  let p = makeProc(sine(440, 8));
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5 });
  send(p, { type: 'seek', time: 1.1 });
  send(p, { type: 'play' });
  render(p, 40);
  send(p, { type: 'scratch', delta: 0, t: 1 });
  let t = 1;
  const outs = [];
  for (let i = 0; i < 60; i++) {
    t += 1 / 60;
    send(p, { type: 'scratch', delta: 0.01, t }); // +0.6 s in total
    outs.push(render(p, 6));
  }
  assert.ok(p.pos / SR > 1.55, `the record followed the hand out of the loop: ${p.pos / SR}`);
  assert.equal(p.loopOn, true, 'still suspended, not dropped, while held');
  send(p, { type: 'scratch', target: null });
  outs.push(render(p, 120));
  assert.equal(p.loopOn, false, 'released outside: dropped');
  assert.ok(posted.some((m) => m.type === 'loop' && m.on === false && m.reason === 'scratch'));
  assert.ok(allFinite(outs.flatMap((a) => [...a])));

  // grab, nudge inside the loop, release -> the loop goes on
  posted.length = 0;
  p = makeProc(sine(440, 8));
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5 });
  send(p, { type: 'seek', time: 1.1 });
  send(p, { type: 'play' });
  render(p, 40);
  send(p, { type: 'scratch', delta: 0, t: 1 });
  send(p, { type: 'scratch', delta: 0.1, t: 1.016 });
  render(p, 30);
  send(p, { type: 'scratch', target: null });
  const after = render(p, 600);
  assert.equal(p.loopOn, true);
  assert.ok(!posted.some((m) => m.type === 'loop'));
  assert.ok(p.pos / SR >= 1.0 && p.pos / SR < 1.5 + 1e-6, `pos ${p.pos / SR}`);
  assert.ok(allFinite(after));
});

test('loop: a seek outside drops it, a seek inside keeps it', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 8));
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5 });
  send(p, { type: 'seek', time: 1.1 });
  send(p, { type: 'play' });
  render(p, 40);
  send(p, { type: 'seek', time: 1.3 });
  render(p, 20);
  assert.equal(p.loopOn, true);
  assert.ok(Math.abs(p.pos / SR - 1.3) < 0.1);
  send(p, { type: 'seek', time: 4 });
  render(p, 20);
  assert.equal(p.loopOn, false);
  assert.ok(posted.some((m) => m.type === 'loop' && m.on === false && m.reason === 'seek'));
  render(p, 400);
  assert.ok(p.pos / SR > 4.5, 'plays on from the cue, no wrap');
});

test('loop set while the playhead is already past its end folds into it without a step', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 1.9 });
  send(p, { type: 'play' });
  const a = render(p, 60);
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5 });
  const b = render(p, 200);
  assert.ok(p.pos / SR >= 1.0 && p.pos / SR < 1.5 + 1e-6, `pos ${p.pos / SR}`);
  const all = new Float32Array(a.length + b.length);
  all.set(a);
  all.set(b, a.length);
  assert.ok(maxStep(all) < SLOPE + 0.004, `max step ${maxStep(all)}`);
});

test('loop: invalid loops are ignored', () => {
  const p = makeProc(sine(440, 4));
  for (const m of [
    { start: NaN, end: 1 },
    { start: 1, end: NaN },
    { start: 2, end: 1 },
    { start: 1, end: 1.005 }, // shorter than 20 ms
    { start: -1, end: 1 },
    { start: 1, end: 3.999 }, // no room for the seam crossfade before the track end
    { start: 1, end: 99 },
    { start: 'x', end: 2 },
  ]) {
    send(p, { type: 'loop', on: true, ...m });
    assert.equal(p.loopOn, false, JSON.stringify(m));
  }
  const q = new registered(); // no track
  send(q, { type: 'loop', on: true, start: 1, end: 2 });
  assert.equal(q.loopOn, false);
});

test('loading a new track clears the loop', () => {
  const p = makeProc(sine(440, 4));
  send(p, { type: 'loop', on: true, start: 1, end: 2 });
  send(p, { type: 'load', left: sine(220, 3), right: null, sampleRate: SR });
  assert.equal(p.loopOn, false);
});

test('loop: grab right after a wrap at the (loop-folded) heard position, release without dragging, keeps the loop', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 1.2 });
  render(p, 10);
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.46875 });
  send(p, { type: 'play' });
  for (let i = 0; i < 2000 && p.loopXfLeft === 0; i++) render(p, 1);
  assert.ok(p.loopXfLeft > 0, 'just wrapped');
  // the listener still hears the tail of the previous repeat: 40 ms before the loop end
  send(p, { type: 'scratch', delta: 0, at: 1.46875 - 0.04, t: 0 });
  render(p, 40);
  send(p, { type: 'scratch', target: null });
  render(p, 30);
  assert.equal(p.loopOn, true, 'still looping');
  assert.ok(!posted.some((m) => m.type === 'loop'), 'no drop message');
  assert.ok(p.pos / SR >= 1.0 && p.pos / SR < 1.46875 + 1e-6);
});

test('pos reports carry the time and length of the last wrap; entering a loop, a seek or a new loop is not a wrap', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 1.0 });
  render(p, 10);
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5 });
  send(p, { type: 'play' });
  const t0 = globalThis.currentTime;
  render(p, 40); // ~0.1 s: playing from the loop start, no wrap yet
  let reports = posted.filter((m) => m.type === 'pos');
  assert.ok(reports.length > 0 && reports.every((m) => m.wrap === -1), 'no wrap yet: wrap is -1');
  posted.length = 0;
  render(p, 1000); // 2.7 s: five wraps of a 0.5 s loop
  reports = posted.filter((m) => m.type === 'pos');
  const last = reports[reports.length - 1];
  const expectedWrap = t0 + 0.5 * Math.floor((last.ctxTime - t0 - 0.002) / 0.5); // wraps every 0.5 s of engine time
  assert.ok(last.wrap > 0 && Math.abs(last.wrap - expectedWrap) < 0.006, `wrap ${last.wrap} expected ${expectedWrap}`);
  assert.ok(Math.abs(last.wrapLen - 0.5) < 1e-9, `wrapLen ${last.wrapLen}`);
  assert.ok(last.wrap <= last.ctxTime);
  // after an exit the last wrap stays on record (the audio history is still true)
  send(p, { type: 'loop', on: false });
  posted.length = 0;
  render(p, 5);
  assert.ok(posted.find((m) => m.type === 'pos').wrap > 0);
  // a seek resets it
  send(p, { type: 'seek', time: 3 });
  posted.length = 0;
  render(p, 20);
  assert.equal(posted.filter((m) => m.type === 'pos').pop().wrap, -1);
});

test('loop: scratch grab at the seam does not leave a crossfade running under the hand', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'loop', on: true, start: 1.0, end: 1.5006 });
  send(p, { type: 'seek', time: 1.49 });
  send(p, { type: 'play' });
  for (let i = 0; i < 80 && p.loopXfLeft === 0; i++) render(p, 1);
  assert.ok(p.loopXfLeft > 0);
  send(p, { type: 'scratch', delta: 0, t: 1 });
  assert.equal(p.loopXfLeft, 0);
  assert.ok(allFinite(render(p, 100)));
});
