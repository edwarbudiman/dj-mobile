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
