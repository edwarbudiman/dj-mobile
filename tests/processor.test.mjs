// Runs js/audio/deck-processor.js under a stubbed AudioWorkletGlobalScope.
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

function sine(freq, seconds, amp = 0.5, rate = SR) {
  const a = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return a;
}

function makeProc(left, right = null) {
  const p = new registered();
  p.port.onmessage({ data: { type: 'load', left, right, sampleRate: SR } });
  return p;
}
const send = (p, m) => p.port.onmessage({ data: m });

/** Render `blocks` blocks of 128 frames; returns the left channel as one array. */
function render(p, blocks) {
  const out = new Float32Array(blocks * 128);
  for (let b = 0; b < blocks; b++) {
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    p.process([], [[L, R]]);
    out.set(L, b * 128);
    globalThis.currentTime += 128 / SR;
  }
  return out;
}

function maxStep(a, from = 1) {
  let m = 0;
  for (let i = Math.max(1, from); i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
}
const allFinite = (a) => a.every(Number.isFinite);

// A 440 Hz sine at amplitude 0.5 changes by at most 0.5 * 2*pi*440/48000 = 0.0288 per sample.
// The gain ramp adds at most amp / (0.006 * 48000) = 0.0017. Anything under 0.04 is click-free.
const LIMIT = 0.04;

test('baseline: playing a sine produces no step above the sine\'s own slope', () => {
  const p = makeProc(sine(440, 2));
  send(p, { type: 'play' });
  const out = render(p, 200);
  assert.ok(maxStep(out) < LIMIT, `max step ${maxStep(out)}`);
  assert.ok(Math.max(...out) > 0.4, 'produces audible output');
});

test('NaN seek is ignored and does not poison the output', () => {
  const p = makeProc(sine(440, 2));
  send(p, { type: 'play' });
  render(p, 20);
  send(p, { type: 'seek', time: NaN });
  send(p, { type: 'seek', time: Infinity });
  send(p, { type: 'seek', time: undefined });
  const out = render(p, 50);
  assert.ok(allFinite(out));
  assert.ok(Number.isFinite(p.pos) && Number.isFinite(p.rate) && Number.isFinite(p.gain));
  assert.ok(Math.max(...out) > 0.4, 'still playing');
  assert.ok(maxStep(out) < LIMIT);
});

test('NaN scratch target and NaN rate are ignored', () => {
  const p = makeProc(sine(440, 2));
  send(p, { type: 'play' });
  render(p, 20);
  send(p, { type: 'scratch', target: NaN });
  send(p, { type: 'rate', value: NaN });
  const out = render(p, 50);
  assert.ok(allFinite(out));
  assert.equal(p.scratchTarget, null);
  assert.ok(Number.isFinite(p.pos) && Number.isFinite(p.rate));
  assert.ok(Math.max(...out) > 0.4);
});

test('a scratch target is followed and released cleanly', () => {
  const p = makeProc(sine(440, 4));
  send(p, { type: 'play' });
  render(p, 20);
  send(p, { type: 'scratch', target: 1.0 });
  const out = render(p, 100);
  assert.ok(allFinite(out));
  assert.ok(Math.abs(p.pos / SR - 1.0) < 0.05, `pos ${p.pos / SR}`);
  send(p, { type: 'scratch', target: null });
  assert.ok(allFinite(render(p, 50)));
});

test('end of track: fades out, posts ended, no step larger than the ramp allows', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 0.3));
  send(p, { type: 'play' });
  const out = render(p, 200);
  assert.ok(posted.some((m) => m.type === 'ended' && m.edge === 'end'), 'ended posted');
  assert.ok(maxStep(out) < LIMIT, `max step ${maxStep(out)}`);
  assert.equal(p.playing, false);
  assert.equal(out[out.length - 1], 0);
});

test('reverse playback reaching the start also fades out', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 0.5));
  send(p, { type: 'seek', time: 0.4 });
  send(p, { type: 'rate', value: -1 });
  p.rate = -1;
  send(p, { type: 'play' });
  const out = render(p, 200);
  assert.ok(posted.some((m) => m.type === 'ended' && m.edge === 'start'), 'ended at start');
  assert.ok(maxStep(out) < LIMIT, `max step ${maxStep(out)}`);
});

test('loading onto a playing deck fades out before swapping buffers', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 3));
  send(p, { type: 'play' });
  const before = render(p, 50);
  const next = sine(660, 1, 0.5);
  send(p, { type: 'load', left: next, right: null, sampleRate: SR });
  assert.notEqual(p.left, next, 'not swapped while audible');
  const after = render(p, 50);
  assert.equal(p.left, next, 'swapped once silent');
  const all = new Float32Array(before.length + after.length);
  all.set(before);
  all.set(after, before.length);
  assert.ok(maxStep(all) < LIMIT, `max step ${maxStep(all)}`);
  assert.equal(p.playing, false);
  assert.equal(p.pos, 0);
  assert.equal(after[after.length - 1], 0, 'new track starts paused');
});

test('direction reversal (+1 to -1) has no DC step', () => {
  const p = makeProc(sine(440, 6));
  send(p, { type: 'seek', time: 3 });
  send(p, { type: 'play' });
  render(p, 100);
  send(p, { type: 'rate', value: -1 });
  const out = render(p, 300);
  assert.ok(allFinite(out));
  assert.ok(maxStep(out) < LIMIT, `max step ${maxStep(out)}`);
  send(p, { type: 'rate', value: 1 });
  const back = render(p, 300);
  assert.ok(maxStep(back) < LIMIT, `max step back ${maxStep(back)}`);
});

test('a stalled scratch (target = position) fades to silence without a step', () => {
  const p = makeProc(sine(440, 4));
  send(p, { type: 'seek', time: 1 });
  send(p, { type: 'play' });
  render(p, 50);
  send(p, { type: 'scratch', target: p.pos / SR });
  const out = render(p, 200);
  assert.ok(maxStep(out) < LIMIT, `max step ${maxStep(out)}`);
  assert.ok(Math.abs(out[out.length - 1]) < 1e-3, 'silent once stalled');
});

test('position reports carry pos, ctxTime and speed', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 2));
  send(p, { type: 'play' });
  render(p, 40);
  const reports = posted.filter((m) => m.type === 'pos');
  assert.ok(reports.length >= 4, 'about 47 Hz');
  const last = reports[reports.length - 1];
  assert.ok(last.pos > 0 && Number.isFinite(last.ctxTime));
  assert.ok(Math.abs(last.speed - 1) < 1e-6);
});

test('a track at a different sample rate plays at the right speed', () => {
  const p = new registered();
  p.port.onmessage({ data: { type: 'load', left: sine(440, 2, 0.5, 24000), right: null, sampleRate: 24000 } });
  send(p, { type: 'play' });
  render(p, 375); // 1.0 s of output
  assert.ok(Math.abs(p.pos / 24000 - 1.0) < 0.02, `track position ${p.pos / 24000}`);
});

// ---- scratching (M3) ----------------------------------------------------------------------------

const BLOCK = 128 / SR;
const peakAbs = (a, from = 0, to = a.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]));
  return m;
};

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Drive a drag like a touch screen: pointer events at ~`hz`, each with +/-`jitter` seconds of timing
 * noise, delivered at block boundaries. x(t) is the finger position in track seconds t seconds after
 * the grab. Returns the left output, the rate after every block and the final finger position.
 */
function drag(p, x, seconds, { hz = 60, jitter = 0.003, seed = 7 } = {}) {
  const rnd = lcg(seed);
  const t0 = globalThis.currentTime;
  send(p, { type: 'scratch', delta: 0, t: t0 });
  const events = [];
  for (let k = 1; k / hz < seconds; k++) events.push(k / hz + (rnd() * 2 - 1) * jitter);
  events.sort((a, b) => a - b);
  const blocks = Math.ceil(seconds / BLOCK);
  const out = new Float32Array(blocks * 128);
  const rates = [];
  let prevX = 0;
  let ei = 0;
  for (let b = 0; b < blocks; b++) {
    const now = globalThis.currentTime - t0;
    while (ei < events.length && events[ei] <= now + BLOCK) {
      const xt = x(events[ei]);
      send(p, { type: 'scratch', delta: xt - prevX, t: t0 + events[ei] });
      prevX = xt;
      ei++;
    }
    out.set(render(p, 1), b * 128);
    rates.push(p.rate);
  }
  return { out, rates, finger: prevX };
}

const maxAbsDiff = (a) => {
  let m = 0;
  for (let i = 1; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
};
const maxJump = (r) => {
  let m = 0;
  for (let i = 1; i < r.length; i++) m = Math.max(m, Math.abs(r[i] - r[i - 1]));
  return m;
};
// Starts at rest, pushes forward to +0.4 s at 0.3 s, then pulls back; at 0.45 s it is at +0.2 s moving
// backward at 2.1x. Peak speed 2.1x.
const wobble = (t) => 0.2 * (1 - Math.cos((2 * Math.PI * t) / 0.6));

test('scratch: irregular 60 Hz drag forward then backward is smooth, reverses, and lands on the finger', () => {
  const p = makeProc(sine(440, 10));
  send(p, { type: 'seek', time: 4 });
  render(p, 10);
  const { out, rates, finger } = drag(p, wobble, 0.45);
  assert.ok(allFinite(out));
  assert.ok(Math.max(...rates) > 1.5, `forward rate ${Math.max(...rates)}`);
  assert.ok(Math.min(...rates) < -1.5, `reverse rate ${Math.min(...rates)}`); // audio really plays backwards
  assert.ok(peakAbs(out) > 0.3, 'audible');
  // a 440 Hz sine at amp 0.5 slopes at most 0.0288 per sample per unit of speed
  assert.ok(maxAbsDiff(out) < 0.0288 * 2.6 + 0.004, `max step ${maxAbsDiff(out)}`);
  assert.ok(maxJump(rates) < 0.3, `rate jump per block ${maxJump(rates)}`); // no zipper / staircase pitch
  const held = render(p, 120);
  assert.ok(peakAbs(held, held.length - 128 * 40) < 1e-3, 'silent while held still');
  assert.ok(Math.abs(p.pos / SR - (4 + finger)) < 0.01, `pos ${p.pos / SR} finger ${4 + finger}`);
});

test('scratch: 120 Hz, heavy jitter and 90 Hz drags stay smooth', () => {
  for (const opts of [{ hz: 120, jitter: 0.001 }, { hz: 60, jitter: 0.006, seed: 3 }, { hz: 90, jitter: 0.004, seed: 11 }]) {
    const p = makeProc(sine(440, 10));
    send(p, { type: 'seek', time: 4 });
    render(p, 10);
    const { out, rates } = drag(p, wobble, 0.45, opts);
    assert.ok(allFinite(out));
    assert.ok(maxAbsDiff(out) < 0.0288 * 2.8 + 0.004, `${JSON.stringify(opts)} step ${maxAbsDiff(out)}`);
    assert.ok(maxJump(rates) < 0.35,`${JSON.stringify(opts)} rate jump ${maxJump(rates)}`);
  }
});

test('scratch: added lag stays under ~26 ms at 60 Hz (event interval + follower)', () => {
  const p = makeProc(sine(440, 10));
  send(p, { type: 'seek', time: 4 });
  render(p, 10);
  const t0 = globalThis.currentTime;
  drag(p, (t) => t, 0.8, { jitter: 0.0005 }); // steady 1x drag
  const lag = globalThis.currentTime - t0 - (p.pos / SR - 4); // finger now minus record now, at 1x
  assert.ok(lag > 0.004 && lag < 0.026, `lag ${lag * 1000} ms`);
});

test('scratch: grabbing a playing deck stops it under the finger; holding still is silent', () => {
  const p = makeProc(sine(440, 6));
  send(p, { type: 'seek', time: 1 });
  send(p, { type: 'play' });
  render(p, 40);
  const before = p.pos;
  send(p, { type: 'scratch', delta: 0, t: globalThis.currentTime });
  const out = render(p, 200);
  assert.ok(allFinite(out));
  assert.ok(maxAbsDiff(out) < LIMIT, `max step ${maxAbsDiff(out)}`);
  assert.ok(peakAbs(out, out.length - 2000) < 1e-3, 'silent');
  assert.ok(Math.abs(p.pos - before) / SR < 0.05, 'stopped within a few ms of where it was');
  assert.ok(Math.abs(p.rate) < 0.01);
});

test('scratch: slow drags do not click', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 3 });
  render(p, 5);
  const { out } = drag(p, (t) => 0.08 * t, 1.5);
  assert.ok(allFinite(out));
  assert.ok(maxAbsDiff(out) < 0.0288 * 0.2 + 0.004, `step ${maxAbsDiff(out)}`);
});

test('scratch release while playing: motor spins back up to the pitch rate and playback continues', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 2 });
  send(p, { type: 'rate', value: 1.05 });
  p.rate = 1.05;
  send(p, { type: 'play' });
  render(p, 40);
  const { out } = drag(p, (t) => -0.3 * Math.sin((Math.PI * t) / 0.4), 0.4);
  assert.ok(allFinite(out));
  send(p, { type: 'scratch', target: null });
  const rel = [];
  const after = new Float32Array(80 * 128);
  for (let i = 0; i < 80; i++) {
    after.set(render(p, 1), i * 128);
    rel.push(p.rate);
  }
  assert.equal(p.scratchTarget, null, 'released');
  assert.equal(p.playing, true);
  assert.ok(Math.abs(rel[rel.length - 1] - 1.05) < 0.02, `settled at ${rel[rel.length - 1]}`);
  assert.ok(maxAbsDiff(after) < 0.0288 * 3, `step ${maxAbsDiff(after)}`); // the pull-back leaves the record at up to ~-2.4x
  assert.ok(peakAbs(after, after.length - 512) > 0.3, 'audible, playing');
  assert.ok(!posted.some((m) => m.type === 'ended'));
});

test('scratch release from a stopped record spins up like a motor (80-150 ms)', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 2 });
  send(p, { type: 'play' });
  render(p, 40);
  send(p, { type: 'scratch', delta: 0, t: globalThis.currentTime });
  render(p, 60);
  send(p, { type: 'scratch', target: null });
  const rates = [];
  for (let i = 0; i < 70; i++) {
    render(p, 1);
    rates.push(p.rate);
  }
  const at = (s) => rates[Math.round(s / BLOCK) - 1];
  assert.ok(at(0.01) < 0.5, `10 ms: ${at(0.01)}`);
  assert.ok(at(0.09) > 0.9 && at(0.09) < 1.0, `90 ms: ${at(0.09)}`);
  assert.ok(Math.abs(at(0.185) - 1) < 0.02, `185 ms: ${at(0.185)}`);
  for (let i = 1; i < rates.length; i++) assert.ok(rates[i] >= rates[i - 1] - 1e-9, 'monotonic: no overshoot');
});

test('scratch release while paused stays stopped and silent at the finger position', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 3 });
  render(p, 10);
  const { out, finger } = drag(p, (t) => 0.5 * Math.min(1, t / 0.4), 0.5);
  send(p, { type: 'scratch', target: null });
  const after = render(p, 200);
  assert.ok(allFinite(out) && allFinite(after));
  assert.equal(p.playing, false);
  assert.equal(p.scratchTarget, null);
  assert.ok(peakAbs(after, after.length - 2000) < 1e-4, 'silent');
  assert.ok(maxAbsDiff(after) < LIMIT);
  assert.ok(Math.abs(p.pos / SR - (3 + finger)) < 0.01, `pos ${p.pos / SR}`);
  const settled = p.pos;
  render(p, 100);
  assert.equal(p.pos, settled, 'does not drift after release');
  assert.equal(p.gain, 0);
  send(p, { type: 'play' }); // and it can be played from there
  const play = render(p, 50);
  assert.ok(peakAbs(play) > 0.3);
  assert.ok(p.pos > settled);
});

test('scratch: pause pressed while grabbed keeps following the hand, release then stops', () => {
  const p = makeProc(sine(440, 8));
  send(p, { type: 'seek', time: 3 });
  send(p, { type: 'play' });
  render(p, 40);
  send(p, { type: 'pause' });
  const { out } = drag(p, (t) => 0.3 * t, 0.5);
  assert.ok(peakAbs(out, out.length - 4000) > 0.2, 'still audible while the hand moves it');
  send(p, { type: 'scratch', target: null });
  const after = render(p, 200);
  assert.equal(p.playing, false);
  assert.ok(peakAbs(after, after.length - 2000) < 1e-4, 'stopped after release');
});

test('scratch: non-finite targets, deltas and timestamps never reach the playhead', () => {
  const p = makeProc(sine(440, 4));
  send(p, { type: 'seek', time: 1 });
  render(p, 10);
  send(p, { type: 'scratch', delta: 0, t: globalThis.currentTime });
  render(p, 40);
  const pos = p.pos;
  for (const m of [
    { type: 'scratch', delta: NaN },
    { type: 'scratch', delta: Infinity },
    { type: 'scratch', delta: -Infinity },
    { type: 'scratch', target: NaN },
    { type: 'scratch', target: Infinity },
    { type: 'scratch', target: 'x' },
    { type: 'scratch', delta: 'x' },
  ]) send(p, m);
  const out = render(p, 40);
  assert.ok(allFinite(out));
  assert.ok(Math.abs(p.pos - pos) < 1);
  assert.ok(Number.isFinite(p.scratchTarget));
  send(p, { type: 'scratch', delta: 0.1, t: NaN }); // a bad timestamp on a good delta still scratches
  send(p, { type: 'scratch', delta: 0.1, t: Infinity });
  assert.ok(allFinite(render(p, 60)));
  assert.ok(Math.abs(p.pos / SR - 1.2) < 0.01, `pos ${p.pos / SR}`);
  assert.ok(Number.isFinite(p.scratchInterval) && p.scratchInterval > 0);
});

test('scratch with no track loaded does nothing', () => {
  const p = new registered();
  send(p, { type: 'scratch', delta: 0.5, t: 0 });
  send(p, { type: 'scratch', target: 1 });
  assert.equal(p.scratchTarget, null);
  assert.equal(p.process([], [[new Float32Array(128), new Float32Array(128)]]), true);
});

test('scratch edges: pushing past the start and end clamps without clicks, ended, or a dead zone', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 3));
  send(p, { type: 'seek', time: 0.3 });
  render(p, 10);
  const a = drag(p, (t) => -2 * t, 0.4); // yanks far past the start
  assert.ok(allFinite(a.out));
  assert.ok(p.pos < 1e-3, `pos ${p.pos}`);
  assert.ok(maxAbsDiff(a.out) < 0.0288 * 8.2 + 0.004, `step ${maxAbsDiff(a.out)}`);
  send(p, { type: 'scratch', delta: 0.5, t: globalThis.currentTime }); // reversing at once moves the record
  render(p, 100);
  assert.ok(Math.abs(p.pos / SR - 0.5) < 0.02, `pos ${p.pos / SR}`);
  send(p, { type: 'scratch', delta: 100, t: globalThis.currentTime }); // and past the end
  const b = render(p, 400);
  assert.ok(allFinite(b));
  assert.ok(Math.abs(p.pos - (p.length - 1)) < 1, `pos ${p.pos} of ${p.length - 1}`);
  assert.ok(maxAbsDiff(b) < 0.0288 * 8.2 + 0.004);
  send(p, { type: 'scratch', delta: -0.5, t: globalThis.currentTime });
  render(p, 100);
  assert.ok(Math.abs(p.pos / SR - 2.5) < 0.05, `pos ${p.pos / SR}`);
  assert.ok(!posted.some((m) => m.type === 'ended'), 'no ended during the scratch');
});

test('scratch edges: released at the start while playing keeps playing (no spurious ended)', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 4));
  send(p, { type: 'seek', time: 0.4 });
  send(p, { type: 'play' });
  render(p, 40);
  drag(p, (t) => -1.5 * t, 0.4); // hauled back to 0 and held there
  assert.ok(p.pos < 1, `pos ${p.pos}`);
  send(p, { type: 'scratch', target: null });
  const after = render(p, 300);
  assert.ok(allFinite(after));
  assert.ok(!posted.some((m) => m.type === 'ended'), 'no ended');
  assert.equal(p.playing, true);
  assert.ok(p.pos / SR > 0.3, `plays on from the start: ${p.pos / SR}`);
  assert.ok(peakAbs(after, after.length - 1024) > 0.3);
});

test('scratch edges: a backward flick released near the start does not end playback', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 4));
  send(p, { type: 'seek', time: 0.15 });
  send(p, { type: 'play' });
  render(p, 40);
  send(p, { type: 'scratch', delta: 0, t: globalThis.currentTime });
  for (let i = 0; i < 12; i++) {
    send(p, { type: 'scratch', delta: -0.03, t: globalThis.currentTime });
    render(p, 3);
  }
  send(p, { type: 'scratch', target: null });
  const after = render(p, 300);
  assert.ok(allFinite(after));
  assert.ok(!posted.some((m) => m.type === 'ended'), 'no ended');
  assert.equal(p.playing, true);
  assert.ok(p.pos / SR > 0.1, `playing on: ${p.pos / SR}`);
});

test('scratch edges: released at the end while playing ends the track normally', () => {
  posted.length = 0;
  const p = makeProc(sine(440, 2));
  send(p, { type: 'seek', time: 1.5 });
  send(p, { type: 'play' });
  render(p, 40);
  send(p, { type: 'scratch', delta: 100, t: globalThis.currentTime });
  render(p, 100);
  send(p, { type: 'scratch', target: null });
  const after = render(p, 200);
  assert.ok(allFinite(after));
  assert.ok(maxAbsDiff(after) < LIMIT);
  assert.ok(posted.some((m) => m.type === 'ended' && m.edge === 'end'));
  assert.equal(p.playing, false);
});

test('scratch: seek is ignored mid-grab, and play at the end edge does not jump to the start', () => {
  const p = makeProc(sine(440, 3));
  send(p, { type: 'seek', time: 1 });
  render(p, 10);
  send(p, { type: 'scratch', delta: 0, t: globalThis.currentTime });
  send(p, { type: 'seek', time: 2.5 });
  render(p, 40);
  assert.ok(Math.abs(p.pos / SR - 1) < 0.01, 'seek ignored');
  send(p, { type: 'scratch', delta: 100, t: globalThis.currentTime });
  render(p, 100);
  send(p, { type: 'play' });
  const out = render(p, 60);
  assert.ok(allFinite(out));
  assert.ok(Math.abs(p.pos - (p.length - 1)) < 1, 'still at the end, not restarted');
  assert.equal(p.pendingSeek, null);
});

test('scratch: loading a new track mid-grab releases cleanly', () => {
  const p = makeProc(sine(440, 4));
  send(p, { type: 'seek', time: 1 });
  send(p, { type: 'play' });
  render(p, 20);
  send(p, { type: 'scratch', delta: 0, t: globalThis.currentTime });
  send(p, { type: 'scratch', delta: 0.2, t: globalThis.currentTime });
  render(p, 10);
  const next = sine(660, 1);
  send(p, { type: 'load', left: next, right: null, sampleRate: SR });
  const out = render(p, 60);
  assert.equal(p.left, next);
  assert.equal(p.scratchTarget, null);
  assert.equal(p.spinUp, false);
  assert.equal(p.braking, false);
  assert.ok(allFinite(out));
  assert.equal(p.pos, 0);
  assert.equal(p.gain, 0);
  send(p, { type: 'play' });
  assert.ok(peakAbs(render(p, 50)) > 0.3);
});

test('scratch: a release immediately followed by a new grab continues without a hitch', () => {
  const p = makeProc(sine(440, 6));
  send(p, { type: 'seek', time: 2 });
  render(p, 10);
  send(p, { type: 'scratch', delta: 0, t: globalThis.currentTime });
  send(p, { type: 'scratch', delta: 0.3, t: globalThis.currentTime });
  render(p, 3);
  send(p, { type: 'scratch', target: null });
  send(p, { type: 'scratch', delta: 0, t: globalThis.currentTime });
  const out = render(p, 100);
  assert.ok(allFinite(out));
  assert.notEqual(p.scratchTarget, null, 'still grabbed');
  assert.ok(maxAbsDiff(out) < 0.0288 * 8.2 + 0.004);
});

// ---- per-sample speed steps, stop bounce, grab at the heard position (M3 review fixes) -----------------

const DC = new Float32Array(SR * 20).fill(0.5);

/**
 * Realistic finger: events at a random 50-120 Hz, delivered 1-4 ms late with +/-2 ms timestamp jitter.
 * Logs the playhead position of every sample read and the gain envelope (right channel is DC 0.5, so
 * outR / 0.5 is exactly gain * gate). The deck starts paused at 10 s.
 */
function scene(finger, dur, { seed = 1, after = 0.3, skipZero = false, startPos = 10, hz = 0 } = {}) {
  const rnd = lcg(seed);
  const p = makeProc(sine(440, 20, 0.8), DC);
  send(p, { type: 'seek', time: startPos });
  render(p, 10);
  const pos = [];
  const orig = p.read.bind(p);
  p.read = (x) => {
    pos.push(x);
    orig(x);
  };
  const t0 = globalThis.currentTime;
  const ev = [];
  if (hz) {
    for (let k = 1; k / hz < dur; k++) ev.push(k / hz + (rnd() * 2 - 1) * 0.002); // steady rate, +/-2 ms timing noise
  } else {
    for (let t = 0; ; ) {
      t += 1 / (50 + rnd() * 70); // irregular 50-120 Hz
      if (t >= dur) break;
      ev.push(t);
    }
  }
  const deliv = ev.map((te) => te + 0.001 + rnd() * 0.003);
  send(p, { type: 'scratch', delta: 0, t: 500 });
  const env = [];
  let prev = 0;
  let ei = 0;
  for (let b = 0; b < Math.ceil((dur + after) / BLOCK); b++) {
    const now = globalThis.currentTime - t0;
    while (ei < ev.length && deliv[ei] <= now) {
      const x = finger(ev[ei]);
      if (!(skipZero && x === prev)) send(p, { type: 'scratch', delta: x - prev, t: 500 + ev[ei] + (rnd() * 2 - 1) * 0.002 });
      prev = x;
      ei++;
    }
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    p.process([], [[L, R]]);
    globalThis.currentTime += BLOCK;
    for (let i = 0; i < 128; i++) env.push(R[i] / 0.5);
  }
  return { p, pos, env, finger: prev, startPos };
}

// Largest change of playback speed between two adjacent samples, in multiples of normal speed.
function maxSpeedStep(pos) {
  let m = 0;
  for (let i = 2; i < pos.length; i++) m = Math.max(m, Math.abs(pos[i] - 2 * pos[i - 1] + pos[i - 2]));
  return m;
}

test('scratch: reversals never snap the glide reference (no per-sample speed steps above 0.05x)', () => {
  const cases = [
    ['baby scratch 3 Hz +/-75 ms', (t) => 0.075 * (1 - Math.cos(2 * Math.PI * 3 * t)), 0.05],
    ['cuts 4 Hz 0.3 s peak-to-peak', (t) => 0.15 * (1 - Math.cos(2 * Math.PI * 4 * t)), 0.05],
    ['triangle 2 Hz +/-2x', (t) => ((t * 2) % 1 < 0.5 ? ((t * 2) % 1) * 2 : (1 - ((t * 2) % 1)) * 2), 0.06], // abrupt turns
  ];
  for (const [name, finger, bound] of cases) {
    for (const seed of [1, 2, 3]) {
      const { pos, p } = scene(finger, 2, { seed });
      assert.ok(pos.every(Number.isFinite), name);
      const step = maxSpeedStep(pos);
      assert.ok(step < bound, `${name} seed ${seed}: max per-sample speed step ${step.toFixed(4)}x`);
      assert.ok(p.pos > 0 && Number.isFinite(p.scratchRef));
    }
  }
});

test('scratch: an abrupt stop at 2x neither bounces audibly nor leaves the record off the finger', () => {
  const { pos, env, p, finger, startPos } = scene((t) => (t < 0.4 ? 2 * t : 0.8), 1.0, { skipZero: true });
  const stop = Math.round(0.4 * SR);
  let overshoot = 0;
  let loudReverse = 0;
  for (let i = stop; i < pos.length; i++) {
    overshoot = Math.max(overshoot, pos[i] / SR - startPos - finger);
    if (pos[i] - pos[i - 1] < -0.02 && env[i] > 0.5) loudReverse++;
  }
  assert.ok(overshoot < 0.005, `overshoot ${overshoot * 1000} ms`);
  // was ~40 ms. Muting the crawl sooner would start ducking real reversals (see the next test): this is the
  // chosen trade-off, about 5 ms of a ~1x crawl at the level it had.
  assert.ok(loudReverse < 0.006 * SR, `audible reverse crawl ${(loudReverse / SR) * 1000} ms`);
  assert.ok(Math.abs(p.pos / SR - startPos - finger) < 0.001, 'the record ends up on the finger');
  assert.ok(env[env.length - 1] < 0.01 || Math.abs(p.rate) < 0.01, 'silent once stopped');
});

test('scratch: a finger that stops and a finger that is merely late are told apart (no dip in a steady drag)', () => {
  const { env, pos } = scene((t) => t, 2, { seed: 5, after: 0 });
  const audible = env.slice(2000); // after the grab's start
  assert.ok(Math.min(...audible) > 0.98, `envelope dipped to ${Math.min(...audible)}`);
  assert.ok(maxSpeedStep(pos) < 0.05);
});

test('scratch: real reversals (4 Hz cuts, baby scratches) are not ducked while the record moves faster than 0.1x', () => {
  const cases = [
    ['cuts 4 Hz', (t) => 0.15 * (1 - Math.cos(2 * Math.PI * 4 * t))],
    ['baby scratch 2 Hz', (t) => 0.1 * (1 - Math.cos(2 * Math.PI * 2 * t))],
  ];
  for (const [name, finger] of cases) {
    for (const seed of [1, 2, 3]) {
      const { pos, env } = scene(finger, 3, { seed, hz: 50 });
      let ducked = 0;
      let minEnv = 1;
      for (let i = 2000; i < 2.9 * SR; i++) { // the drag itself; the finger stops at 3 s
        if (Math.abs(pos[i] - pos[i - 1]) > 0.1) {
          if (env[i] < 0.9) ducked++;
          minEnv = Math.min(minEnv, env[i]);
        }
      }
      // was ~46 ms per 3 s with a dip to 0.03; the speed gate now opens fast and the stop-mute needs a late event
      assert.ok(ducked < 0.001 * SR, `${name} seed ${seed}: ${(ducked / SR) * 1000} ms below 0.9, min ${minEnv}`);
      assert.ok(minEnv > 0.5, `${name} seed ${seed}: min envelope ${minEnv}`); // single-sample-scale dips, was 0.03
    }
  }
});

test('scratch: the grab can start from the heard position (latency-adjusted `at`) without a click', () => {
  const p = makeProc(sine(440, 6, 0.8));
  send(p, { type: 'seek', time: 3 });
  send(p, { type: 'play' });
  render(p, 40);
  const engine = p.pos / SR;
  const heard = engine - 0.2; // e.g. Bluetooth output latency
  send(p, { type: 'scratch', delta: 0, at: heard, t: 1 });
  const out = render(p, 80);
  assert.ok(allFinite(out));
  assert.ok(maxAbsDiff(out) < LIMIT, `step ${maxAbsDiff(out)}`);
  assert.ok(Math.abs(p.pos / SR - heard) < 0.003, `grabbed at ${p.pos / SR}, wanted ${heard}`);
  assert.ok(peakAbs(out, out.length - 1500) < 1e-3, 'held still: silent');
  // moves are relative to that point
  send(p, { type: 'scratch', delta: 0.1, t: 1.02 });
  render(p, 80);
  assert.ok(Math.abs(p.pos / SR - (heard + 0.1)) < 0.003, `pos ${p.pos / SR}`);
  // a non-finite `at` is ignored: the grab stays where the record is
  const q = makeProc(sine(440, 6, 0.8));
  send(q, { type: 'seek', time: 3 });
  render(q, 10);
  send(q, { type: 'scratch', delta: 0, at: NaN, t: 1 });
  render(q, 40);
  assert.ok(Math.abs(q.pos / SR - 3) < 0.003);
});
