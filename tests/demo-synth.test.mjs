// Demo loops: deterministic synthesis, exact grid, no clipping, yields to the event loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMOS, DEMO_PEAK, DEMO_RATE, YIELD_BUDGET_MS, demoDuration, renderDemo } from '../js/audio/demo-synth.js';
import { downmixDecimate } from '../js/audio/peaks.js';
import { analyzeTempo } from '../js/audio/bpm-core.js';

const noYield = () => Promise.resolve();
const rendered = new Map();
async function get(def) {
  if (!rendered.has(def.id)) rendered.set(def.id, renderDemo(def, { yieldFn: noYield }));
  return rendered.get(def.id);
}

test('there are two demos at two different BPMs, 60-90 s long, with unique ids', () => {
  assert.ok(DEMOS.length >= 2);
  assert.equal(new Set(DEMOS.map((d) => d.bpm)).size, DEMOS.length);
  assert.equal(new Set(DEMOS.map((d) => d.id)).size, DEMOS.length);
  for (const d of DEMOS) {
    assert.ok(d.id.startsWith('demo:'));
    assert.ok(demoDuration(d) >= 60 && demoDuration(d) <= 90, `${d.name} ${demoDuration(d)} s`);
    assert.equal(d.sections.length * 4, d.bars, 'one section string per 4 bars');
  }
});

for (const def of DEMOS) {
  test(`${def.name}: finite, stereo, exact length, peak at -1 dBFS (no clipping)`, async () => {
    const r = await get(def);
    assert.equal(r.sampleRate, DEMO_RATE);
    assert.equal(r.left.length, r.length);
    assert.equal(r.right.length, r.length);
    assert.ok(Math.abs(r.duration - demoDuration(def)) < 1 / DEMO_RATE);
    let peak = 0;
    let diff = 0;
    for (let i = 0; i < r.length; i++) {
      const l = r.left[i];
      const rr = r.right[i];
      assert.ok(Number.isFinite(l) && Number.isFinite(rr), `sample ${i}`);
      peak = Math.max(peak, Math.abs(l), Math.abs(rr));
      diff += Math.abs(l - rr);
    }
    assert.ok(peak <= DEMO_PEAK + 1e-6 && peak > DEMO_PEAK - 0.01, `peak ${peak}`);
    assert.ok(diff / r.length > 1e-4, 'genuinely stereo');
    assert.ok(Math.abs(r.left[r.length - 1]) < 1e-9, 'faded out at the very end');
    assert.equal(r.bpm, def.bpm);
    assert.equal(r.offset, 0);
  });

  test(`${def.name}: the kick lands on every beat of the grid (known BPM and offset 0)`, async () => {
    const r = await get(def);
    const sr = r.sampleRate;
    const spb = 60 / def.bpm;
    // low band only (kick + bass), crude one-pole at ~150 Hz, then the level in a 25 ms window
    const a = 1 - Math.exp((-2 * Math.PI * 150) / sr);
    const low = new Float32Array(r.length);
    let y = 0;
    for (let i = 0; i < r.length; i++) {
      y += a * (r.left[i] - y);
      low[i] = Math.abs(y);
    }
    const win = Math.round(0.025 * sr);
    const level = (t) => {
      let s = 0;
      const i0 = Math.round(t * sr);
      for (let i = i0; i < i0 + win; i++) s += low[i];
      return s / win;
    };
    let ok = 0;
    for (let beat = 1; beat <= 16; beat++) {
      // intro (bars 0-3) is kick + hats only: the low band jumps at the beat, against the decayed tail just before it
      if (level(beat * spb) > 3 * level(beat * spb - 0.03)) ok++;
    }
    assert.equal(ok, 16, `${ok} of 16 beats carry a kick transient`);
    assert.ok(level(0) > 0.01, 'and the very first beat too');
  });

  test(`${def.name}: the app's own tempo detector reads the designed BPM`, async () => {
    const r = await get(def);
    const factor = Math.round(r.sampleRate / 11025);
    const mono = downmixDecimate(r.left, r.right, 0, r.length, factor);
    const res = await analyzeTempo(mono, r.sampleRate / factor, { startTime: 0, yieldFn: noYield });
    assert.ok(res && res.bpm, 'detected something');
    assert.ok(Math.abs(res.bpm - def.bpm) < 0.5, `detected ${res.bpm}, designed ${def.bpm}`);
  });

  test(`${def.name}: evolves (the loudest bars differ from the intro)`, async () => {
    const r = await get(def);
    const bar = Math.round(4 * (60 / def.bpm) * r.sampleRate);
    const rms = (b) => {
      let s = 0;
      for (let i = b * bar; i < (b + 1) * bar; i++) s += r.left[i] * r.left[i];
      return Math.sqrt(s / bar);
    };
    assert.ok(rms(16) > rms(1) * 1.05, 'the full arrangement is fuller than the intro (kick-dominated, so only slightly louder)');
    assert.ok(rms(21) < rms(16) * 0.6, 'the breakdown (no kick) is lighter than the drop');
  });
}

// Deterministic (no wall clock, no timers): the render asks a clock whether the 6 ms budget is spent at
// fixed points that are at most a few thousand samples apart. A fake clock that is always over budget makes
// every such point yield, so the number of yields counts the points and is the same on every machine.
const SHORT = { ...DEMOS[0], bars: 4, sections: ['khcbospr'] };

test('rendering yields at fine-grained points (budget check every <= 4096 samples of a voice) and yielding never changes the audio', async () => {
  let yields = 0;
  const over = await renderDemo(SHORT, {
    clock: (() => {
      let t = 0;
      return () => (t += YIELD_BUDGET_MS + 1);
    })(),
    yieldFn: async () => {
      yields++;
    },
  });
  const never = await renderDemo(SHORT, { clock: () => 0, yieldFn: noYield });
  assert.deepEqual(over.left, never.left);
  assert.deepEqual(over.right, never.right);
  const samples = never.length;
  // the pad (the heaviest voice) alone has ~4.5 notes x 2.7 s x 44100 / 2048 check points per chord bar; a render
  // checking only once per bar would give 8. The master pass adds one per 32768 samples (x2 passes).
  assert.ok(yields > samples / 8192, `${yields} yield points for ${samples} samples`);
  assert.ok(yields > SHORT.bars * 20, `${yields} yield points in ${SHORT.bars} bars`);
});

test('a render under budget never yields mid-bar work (cheap when the machine is fast)', async () => {
  let yields = 0;
  await renderDemo(SHORT, { clock: () => 0, yieldFn: async () => { yields++; } });
  assert.equal(yields, 0);
});

test('progress is reported per bar and a render can be aborted', async () => {
  const progress = [];
  await renderDemo(SHORT, { yieldFn: noYield, onProgress: (f) => progress.push(f) });
  assert.equal(progress.length, SHORT.bars);
  assert.equal(progress[progress.length - 1], 1);
  let n = 0;
  const aborted = await renderDemo(DEMOS[0], { yieldFn: noYield, shouldAbort: () => ++n > 3 });
  assert.equal(aborted, null);
});

test('rendering is deterministic', async () => {
  const def = { ...DEMOS[1], bars: 4, sections: ['khcbosp'] };
  const a = await renderDemo(def, { yieldFn: noYield });
  const b = await renderDemo(def, { yieldFn: noYield });
  assert.deepEqual(a.left, b.left);
});
