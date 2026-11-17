// Deck scratch API (grab point, release ramp, precedence) against a stubbed AudioContext / worklet node.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
globalThis.AudioWorkletNode = class {
  constructor() {
    this.port = { postMessage: (m) => sent.push(m), onmessage: null };
  }
  connect() {}
};
const { Deck } = await import('../js/audio/deck.js');

function stubNode() {
  return { connect() {}, gain: { value: 0, setTargetAtTime() {} }, frequency: { value: 0 }, Q: { value: 0 }, type: '' };
}
function makeDeck() {
  const ctx = { currentTime: 1.0, outputLatency: 0.2, baseLatency: 0, createBiquadFilter: stubNode, createGain: stubNode };
  const d = new Deck(ctx, 'A', stubNode());
  d.track = { name: 't', duration: 60, sampleRate: 48000, length: 60 * 48000, libraryId: null };
  return { d, ctx };
}
const last = () => sent[sent.length - 1];

test('grab: the worklet is told the HEARD position (engine position minus output latency x speed)', () => {
  const { d } = makeDeck();
  d._report = { pos: 5, ctxTime: 0, speed: 3 }; // engine at 5 + 1.0 x 3 = 8 s
  assert.ok(Math.abs(d.position - 8) < 1e-9);
  sent.length = 0;
  assert.equal(d.scratchBegin(), true);
  const heard = 5 + (1.0 - 0.2) * 3; // 7.4
  assert.equal(last().type, 'scratch');
  assert.equal(last().delta, 0);
  assert.ok(Math.abs(last().at - heard) < 1e-9, `at ${last().at}`);
  assert.ok(Number.isFinite(last().t));
  assert.equal(d.scratchBegin(), false, 'one grab at a time');
  assert.ok(Math.abs(d.displayPosition - heard) < 1e-9, 'the display starts where the audio was grabbed');
});

test('release after a fast flick eases the display back over ~70 ms; a release at rest does not slide', () => {
  const { d, ctx } = makeDeck();
  d._report = { pos: 5, ctxTime: 0, speed: 3 };
  d.scratchBegin();
  d.scratchBy(0.5, performance.now());
  const shown = d.displayPosition;
  d.scratchEnd();
  assert.equal(d.grabbed, false);
  assert.equal(last().target, null);
  assert.equal(d._off.tau, 0.07);
  assert.ok(Math.abs(d.heardPosition - shown) < 1e-6, 'continuous at the moment of release (no jump)');
  const base = d._heardBase();
  ctx.currentTime += 0.07;
  const off = d.heardPosition - Math.min(d.duration, d._heardBase());
  assert.ok(Math.abs(off - 0.5 * Math.exp(-1)) < 0.02, `offset after one time constant ${off}`);
  assert.ok(base < shown);

  const rest = makeDeck();
  rest.d._report = { pos: 5, ctxTime: 0, speed: 0 };
  rest.d.scratchBegin();
  rest.d.scratchBy(0.002, performance.now());
  rest.d.scratchEnd();
  assert.equal(rest.d._off.v, 0, 'a normal release gets no slide');
});

test('the hand wins while grabbed: seek and cue are ignored, play/pause only toggle state', () => {
  const { d } = makeDeck();
  d._report = { pos: 5, ctxTime: 1, speed: 0 };
  d.scratchBegin();
  sent.length = 0;
  d.seek(30);
  d.cuePress();
  assert.equal(sent.length, 0, 'nothing reached the worklet');
  d.play();
  assert.equal(d.playing, true);
  assert.deepEqual(sent.map((m) => m.type), ['play']);
  d.pause();
  assert.equal(d.playing, false);
  d.scratchEnd();
  sent.length = 0;
  d.seek(30); // free again
  assert.equal(last().type, 'seek');
});

test('non-finite or zero moves never reach the worklet; no track means no grab', () => {
  const { d } = makeDeck();
  d._report = { pos: 5, ctxTime: 1, speed: 0 };
  d.scratchBegin();
  sent.length = 0;
  d.scratchBy(NaN, 1);
  d.scratchBy(Infinity, 1);
  d.scratchBy(0, 1);
  assert.equal(sent.length, 0);
  d.scratchBy(0.1, NaN); // a bad timestamp falls back to now
  assert.equal(sent.length, 1);
  assert.ok(Number.isFinite(last().t));
  d.scratchEnd();
  d.scratchEnd(); // idempotent
  const empty = makeDeck().d;
  empty.track = null;
  assert.equal(empty.scratchBegin(), false);
});

test('a new track releases the grab (scratchEnd with post=false) and announces it', () => {
  const { d } = makeDeck();
  d._report = { pos: 5, ctxTime: 1, speed: 0 };
  const events = [];
  d.addEventListener('grab', (e) => events.push(e.detail));
  d.scratchBegin();
  sent.length = 0;
  d.scratchEnd('load', false);
  assert.equal(sent.length, 0, 'the load message resets the worklet itself');
  assert.deepEqual(events, [{ grabbed: true, reason: 'grab' }, { grabbed: false, reason: 'load' }]);
});
