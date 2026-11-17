// Deck hot cues, loops, filter and PFL against a stubbed AudioContext / worklet node.
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

const calls = [];
function param(name) {
  return { value: 0, setTargetAtTime: (v, t, tc) => calls.push({ name, v, tc }) };
}
function stubNode() {
  return { connect() {}, gain: param('gain'), frequency: param('freq'), Q: param('Q'), type: '' };
}
function makeDeck({ grid = { bpm: 120, offset: 0, confidence: 1 }, pos = 10.3 } = {}) {
  const ctx = { currentTime: 1.0, sampleRate: 48000, outputLatency: 0, baseLatency: 0, createBiquadFilter: stubNode, createGain: stubNode };
  const d = new Deck(ctx, 'A', stubNode(), stubNode());
  d.track = { name: 't', duration: 100, sampleRate: 48000, length: 100 * 48000, libraryId: 'x' };
  d.grid = grid;
  d._report = { pos, ctxTime: 1.0, speed: 0 };
  return d;
}
const last = () => sent[sent.length - 1];

test('hot cue set snaps to the nearest beat on a confident grid, exact otherwise', () => {
  const d = makeDeck(); // heard 10.3, beats every 0.5 s
  const events = [];
  d.addEventListener('hotcues', (e) => events.push(e.detail));
  assert.ok(Math.abs(d.setHotCue(0) - 10.5) < 1e-9);
  assert.equal(d.hotCues[0], d.hotCues[0]);
  assert.equal(events.at(-1).persist, true);
  d.grid = { bpm: 120, offset: 0, confidence: 0.1 };
  assert.ok(Math.abs(d.setHotCue(1) - 10.3) < 1e-9, 'low-confidence grid: exact');
  d.grid = null;
  assert.ok(Math.abs(d.setHotCue(2) - 10.3) < 1e-9, 'no grid: exact');
  assert.equal(d.setHotCue(4), null);
  assert.equal(d.hotCues.length, 4);
});

test('hot cue jump: plays on when playing, stays paused when paused, ignored while grabbed or unset', () => {
  const d = makeDeck();
  d.setHotCue(0);
  d.hotCues[1] = 40;
  sent.length = 0;
  assert.equal(d.jumpHotCue(2), false, 'unset pad does not jump');
  assert.equal(sent.length, 0);
  assert.equal(d.jumpHotCue(1), true);
  assert.deepEqual(last(), { type: 'seek', time: 40 });
  assert.equal(d.playing, false, 'a paused deck stays paused');
  assert.ok(!sent.some((m) => m.type === 'play'));
  d.playing = true;
  sent.length = 0;
  d.jumpHotCue(1);
  assert.equal(d.playing, true, 'a playing deck keeps playing');
  assert.ok(!sent.some((m) => m.type === 'pause'));
  d.grabbed = true;
  sent.length = 0;
  assert.equal(d.jumpHotCue(1), false);
  assert.equal(sent.length, 0);
});

test('hot cues can be cleared and restored; restore never asks to persist', () => {
  const d = makeDeck();
  const events = [];
  d.addEventListener('hotcues', (e) => events.push(e.detail));
  d.setHotCues([5, null, 200, 'x']); // 200 is past the end of the 100 s track
  assert.deepEqual(d.hotCues, [5, null, null, null]);
  assert.equal(events.at(-1).persist, false);
  d.clearHotCue(0);
  assert.deepEqual(d.hotCues, [null, null, null, null]);
  assert.equal(events.at(-1).persist, true);
  const n = events.length;
  d.clearHotCue(0); // already empty
  assert.equal(events.length, n);
});

test('auto-loop: posts the loop, same size exits, another size keeps the in-point, no grid refuses', () => {
  const d = makeDeck(); // heard 10.3 -> beat at 10.0
  const events = [];
  d.addEventListener('loop', (e) => events.push(e.detail));
  let r = d.autoLoop(4);
  assert.equal(r.ok, true);
  assert.deepEqual(last(), { type: 'loop', on: true, start: 10, end: 12 });
  assert.deepEqual(d.loop, { start: 10, end: 12, beats: 4 });
  r = d.autoLoop(2);
  assert.deepEqual(last(), { type: 'loop', on: true, start: 10, end: 11 });
  r = d.autoLoop(2);
  assert.equal(r.action, 'exit');
  assert.deepEqual(last(), { type: 'loop', on: false });
  assert.equal(d.loop, null);
  assert.equal(events.at(-1).loop, null);
  d.grid = null;
  assert.deepEqual(d.autoLoop(4), { ok: false, reason: 'no-grid' });
  assert.equal(d.loop, null);
});

test('a seek outside the loop ends it, inside keeps it; the worklet drop message is mirrored', () => {
  const d = makeDeck();
  d.autoLoop(4);
  d.seek(11);
  assert.ok(d.loop);
  d.seek(50);
  assert.equal(d.loop, null);
  d.autoLoop(4);
  d._onMessage({ type: 'loop', on: false, reason: 'scratch' });
  assert.equal(d.loop, null);
});

function loopDeck(latency) {
  const ctx = { currentTime: 5.0, sampleRate: 48000, outputLatency: latency, baseLatency: 0, createBiquadFilter: stubNode, createGain: stubNode };
  const d = new Deck(ctx, 'A', stubNode(), stubNode());
  d.track = { name: 't', duration: 100, sampleRate: 48000, length: 4800000, libraryId: 'x' };
  d.grid = { bpm: 128, offset: 0, confidence: 1 };
  d.playing = true;
  d.loop = { start: 10.0, end: 10.0 + 60 / 128, beats: 1 };
  d._off = { v: 0, t: 0 };
  return { d, ctx };
}

test('heard position stays inside a running loop right after a wrap (20 / 60 / 150 ms latency)', () => {
  for (const latency of [0.02, 0.06, 0.15]) {
    const { d, ctx } = loopDeck(latency);
    const { start, end } = d.loop;
    d._onMessage({ type: 'pos', pos: start + 0.01, ctxTime: ctx.currentTime, speed: 1, wrap: ctx.currentTime - 0.01, wrapLen: end - start }); // the worklet wrapped 10 ms ago
    const heard = d.heardPosition;
    const expected = end - (latency - 0.01); // what is really being heard: the tail of the previous repeat
    assert.ok(heard >= start && heard < end, `latency ${latency}: heard ${heard} inside [${start}, ${end})`);
    assert.ok(Math.abs(heard - expected) < 1e-6, `latency ${latency}: error ${Math.abs(heard - expected)} s`);
  }
});

test('the drawn position wraps at the loop end like the audio: never past the end, never before the start', () => {
  const { d, ctx } = loopDeck(0.15);
  const { start, end } = d.loop;
  let wraps = 0;
  let prev = null;
  let reportAt = -1;
  for (let step = 0; step < 400; step++) {
    ctx.currentTime = 5 + step * (1 / 60); // 60 fps frames
    const len = end - start;
    const phase = (ctx.currentTime - 5 + 0.2) % len;
    const engine = start + phase; // the real, wrapped engine position
    if (ctx.currentTime - reportAt >= 0.021) {
      // reports arrive every ~21 ms and carry the time of the most recent wrap
      d._onMessage({ type: 'pos', pos: engine, ctxTime: ctx.currentTime, speed: 1, wrap: ctx.currentTime - phase, wrapLen: len });
      reportAt = ctx.currentTime;
    }
    const shown = d.displayPosition;
    assert.ok(shown >= start - 1e-9 && shown < end + 1e-9, `frame ${step}: shown ${shown} outside the loop`);
    if (prev !== null && shown < prev - 0.1) wraps++;
    prev = shown;
  }
  assert.ok(wraps >= 4, `the playhead wrapped ${wraps} times`);
});

test('a grab right after a wrap posts a position inside the loop; hot cues and taps get loop positions too', () => {
  const { d, ctx } = loopDeck(0.15);
  d._onMessage({ type: 'pos', pos: d.loop.start + 0.01, ctxTime: ctx.currentTime, speed: 1, wrap: ctx.currentTime - 0.01, wrapLen: d.loop.end - d.loop.start });
  sent.length = 0;
  d.scratchBegin();
  const at = sent.find((m) => m.type === 'scratch').at;
  assert.ok(at >= d.loop.start && at < d.loop.end, `grab at ${at}`);
  d.scratchEnd();
  d.grid = null;
  const t = d.setHotCue(0);
  assert.ok(t >= d.loop.start && t < d.loop.end, `hot cue ${t}`);
});

/** Worklet-like reports every ~21 ms for an engine that started at `t0` at the loop start (wraps every loop length). */
function feedReports(d, ctx, t0, upTo, state) {
  const { start, end } = d.loop;
  const len = end - start;
  while (state.next <= upTo) {
    const el = state.next - t0;
    const k = Math.floor(el / len);
    d._onMessage({ type: 'pos', pos: start + (el - k * len), ctxTime: state.next, speed: 1, wrap: k > 0 ? t0 + k * len : -1, wrapLen: len });
    state.next += 1024 / 48000;
  }
}

test('paused at the loop start, set the loop, press Play: the heard position never leaves the loop (20 / 60 / 150 ms)', () => {
  for (const latency of [0.02, 0.06, 0.15]) {
    const ctx = { currentTime: 5.0, sampleRate: 48000, outputLatency: latency, baseLatency: 0, createBiquadFilter: stubNode, createGain: stubNode };
    const d = new Deck(ctx, 'A', stubNode(), stubNode());
    d.track = { name: 't', duration: 100, sampleRate: 48000, length: 4800000, libraryId: 'x' };
    d.grid = { bpm: 128, offset: 0.15625, confidence: 1 }; // 10.0 s is on a beat
    d._report = { pos: 10.0, ctxTime: 5.0, speed: 0 };
    assert.equal(d.autoLoop(1).ok, true);
    const { start, end } = d.loop;
    assert.equal(start, 10);
    const t0 = 5.0;
    d.play();
    const state = { next: t0 + 0.003 };
    let outside = 0;
    let lowest = Infinity;
    let wraps = 0;
    let prev = start;
    for (let ms = 0; ms <= 1500; ms += 5) {
      ctx.currentTime = t0 + ms / 1000;
      feedReports(d, ctx, t0, ctx.currentTime, state);
      const h = d.heardPosition;
      lowest = Math.min(lowest, h);
      if (h < start - 1e-9 || h >= end) outside++;
      if (h < prev - 0.1) wraps++;
      prev = h;
      if (ms === 30) {
        sent.length = 0;
        d.scratchBegin(); // a grab 30 ms after Play must land inside the loop, so letting go without dragging keeps it
        const at = sent.find((m) => m.type === 'scratch').at;
        assert.ok(at >= start && at < end, `latency ${latency}: grab at ${at}`);
        d.scratchEnd();
      }
    }
    assert.equal(outside, 0, `latency ${latency}: ${outside} samples outside the loop, lowest ${lowest}`);
    assert.ok(wraps >= 2, `latency ${latency}: the playhead wrapped ${wraps} times`);
  }
});

test('exit right after a wrap: the heard position carries on without jumping back a loop length', () => {
  for (const latency of [0.02, 0.06, 0.15]) {
    const { d, ctx } = loopDeck(latency);
    const len = d.loop.end - d.loop.start;
    d._onMessage({ type: 'pos', pos: d.loop.start + 0.005, ctxTime: ctx.currentTime, speed: 1, wrap: ctx.currentTime - 0.005, wrapLen: len });
    const before = d.heardPosition;
    d.exitLoop();
    const after = d.heardPosition;
    assert.ok(Math.abs(after - before) < 1e-9, `latency ${latency}: ${before} -> ${after}`);
    // and it keeps advancing at normal speed afterwards (no wrap any more)
    ctx.currentTime += 0.2;
    d._onMessage({ type: 'pos', pos: 10.0 + 0.205, ctxTime: ctx.currentTime, speed: 1, wrap: ctx.currentTime - 0.205, wrapLen: len });
    // the wrap already happened in the audio, so once the old repeat's tail has been heard the position is the
    // plain extrapolation of the report (engine position minus the latency): no stale correction lingers
    assert.ok(Math.abs(d.heardPosition - (10.205 - latency)) < 1e-9, `latency ${latency}: ${d.heardPosition}`);
  }
});

test('hot cue jump to the loop start while looping shows the loop start, not the loop end', () => {
  for (const latency of [0.02, 0.06, 0.15]) {
    const { d, ctx } = loopDeck(latency);
    d._report = { pos: 10.3, ctxTime: ctx.currentTime, speed: 1, wrap: -1, wrapLen: 0 };
    d.hotCues = [d.loop.start, null, null, null];
    d.jumpHotCue(0);
    for (let ms = 0; ms <= 60; ms += 10) {
      ctx.currentTime = 5.0 + ms / 1000;
      const h = d.heardPosition;
      assert.ok(h >= d.loop.start && h < d.loop.end, `latency ${latency} +${ms} ms: ${h}`);
    }
  }
});

test('multiple wraps inside one latency (a loop shorter than the output latency) are all unwound', () => {
  const { d, ctx } = loopDeck(0.3);
  d.loop = { start: 10, end: 10.2, beats: 0.5 };
  // wrapped 5 ms ago; the loop repeats every 0.2 s, the listener is 0.3 s behind
  d._onMessage({ type: 'pos', pos: 10.005, ctxTime: ctx.currentTime, speed: 1, wrap: ctx.currentTime - 0.005, wrapLen: 0.2 });
  const h = d.heardPosition;
  assert.ok(h >= 10 && h < 10.2, `${h}`);
  // 0.3 s ago the engine was 0.305 s into... the previous repeats: position 10.005 - 0.3 + 2 x 0.2 = 10.105
  assert.ok(Math.abs(h - 10.105) < 1e-9, `${h}`);
});

test('without a loop (or when the report is outside it) nothing is folded', () => {
  const { d, ctx } = loopDeck(0.15);
  d._report = { pos: 20, ctxTime: ctx.currentTime, speed: 1 };
  assert.ok(Math.abs(d.heardPosition - 19.85) < 1e-9);
  d.loop = null;
  d._report = { pos: 10.01, ctxTime: ctx.currentTime, speed: 1 };
  assert.ok(Math.abs(d.heardPosition - 9.86) < 1e-9);
});

test('filter: knob position drives both biquads with a glide; the dead zone is a pass-through', () => {
  const d = makeDeck();
  calls.length = 0;
  d.setFilter(0.5);
  const lp = calls.find((c) => c.name === 'freq');
  assert.equal(lp.v, 24000, 'low-pass at Nyquist');
  assert.ok(calls.every((c) => c.tc > 0), 'every change glides (setTargetAtTime)');
  calls.length = 0;
  d.setFilter(0.1);
  assert.ok(calls.filter((c) => c.name === 'freq')[0].v < 3000, 'left: low-pass sweeps down');
  d.setFilter(NaN);
  assert.equal(d.filterPos, 0.5);
});

test('PFL switches the pre-fader send', () => {
  const d = makeDeck();
  calls.length = 0;
  d.setPfl(true);
  assert.equal(d.pfl, true);
  assert.equal(calls.at(-1).v, 1);
  d.setPfl(false);
  assert.equal(calls.at(-1).v, 0);
});
