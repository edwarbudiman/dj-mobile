import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOW_CONFIDENCE, analyzeTempo, pickAnalysisWindow } from '../js/audio/bpm-core.js';
import { downmixDecimate } from '../js/audio/peaks.js';
import { prepareTrack } from '../js/audio/analyzer.js';

const SR = 44100;

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
}

function addKick(out, t, amp, rate) {
  const start = Math.round(t * rate);
  const n = Math.round(0.25 * rate);
  for (let i = 0; i < n && start + i < out.length; i++) {
    if (start + i < 0) continue;
    const env = Math.min(1, i / (0.002 * rate)) * Math.exp(-i / (0.07 * rate));
    const f = 55 + 40 * Math.exp(-i / (0.03 * rate));
    out[start + i] += amp * env * Math.sin((2 * Math.PI * f * i) / rate);
  }
}

function addHat(out, t, amp, rate, rnd) {
  const start = Math.round(t * rate);
  const n = Math.round(0.05 * rate);
  let prev = 0;
  for (let i = 0; i < n && start + i < out.length; i++) {
    if (start + i < 0) continue;
    const w = rnd();
    out[start + i] += amp * Math.exp(-i / (0.012 * rate)) * (w - prev); // crude high-pass
    prev = w;
  }
}

/** Kick on every beat + hat on every offbeat. A quiet intro (same grid, tiny level) can precede the loud part. */
function kickHat({ bpm, offset, seconds, intro = 0, introAmp = 0.01 }) {
  const out = new Float32Array(Math.round(seconds * SR));
  const P = 60 / bpm;
  const rnd = lcg(7);
  for (let t = offset; t < seconds; t += P) {
    const a = t < intro ? introAmp : 1;
    addKick(out, t, 0.8 * a, SR);
    addHat(out, t + P / 2, 0.3 * a, SR, rnd);
  }
  return out;
}

function addSnare(out, t, amp, rate, rnd, tone = 0.4) {
  const start = Math.round(t * rate);
  const n = Math.round(0.15 * rate);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const env = Math.min(1, i / (0.001 * rate)) * Math.exp(-i / (0.04 * rate));
    out[start + i] += amp * env * (0.6 * rnd() + tone * Math.sin((2 * Math.PI * 190 * i) / rate));
  }
}

/**
 * Drum pattern on a grid of 8 slots per bar (a slot = half a beat of `bpm`): kicks and snares
 * are slot indexes, hats play on every slot.
 */
function groove({ bpm, offset = 0.2, seconds = 60, kicks, snares, hatAmp = 0.3, snareTone = 0.4 }) {
  const out = new Float32Array(Math.round(seconds * SR));
  const rnd = lcg(3);
  const slot = 60 / bpm / 2;
  for (let n = 0, t = offset; t < seconds; n++, t += slot) {
    const s = n % 8;
    if (kicks.includes(s)) addKick(out, t, 0.8, SR);
    if (snares.includes(s)) addSnare(out, t, 0.7, SR, rnd, snareTone);
    if (hatAmp) addHat(out, t, hatAmp, SR, rnd);
  }
  return out;
}

/** Drum & bass 2-step at `bpm`: kick on slots 0 and 5 (the "and" of 3), snare on 2 and 6, 8th hats. */
const dnb2step = ({ bpm, offset, seconds, snareTone }) => groove({ bpm, offset, seconds, kicks: [0, 5], snares: [2, 6], snareTone });
/** Hip-hop backbeat: kick on 1 and 3, snare on 2 and 4, 8th hats (a slot is half a beat). */
const hipHop = ({ bpm, seconds = 60, snareTone = 0.4, hatAmp = 0.3, kicks = [0, 4] }) => groove({ bpm, seconds, kicks, snares: [2, 6], hatAmp, snareTone });

const circ = (a, b, period) => {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
};
const toMono = (x) => downmixDecimate(x, x, 0, x.length, 4);

const CASES = [[100, 0.21], [124, 0.087], [127.6, 0.33], [128, 0.13], [140, 0.05], [174, 0.17], [175.5, 0.29]];

for (const [bpm, offset] of CASES) {
  test(`kick + offbeat hats at ${bpm} BPM: tempo within 0.02, phase within 12 ms`, async () => {
    const mono = toMono(kickHat({ bpm, offset, seconds: 90 }));
    const r = await analyzeTempo(mono, SR / 4);
    assert.ok(Math.abs(r.bpm - bpm) <= 0.02, `bpm ${r.bpm}`);
    assert.ok(circ(r.offset, offset, 60 / bpm) <= 0.012, `offset ${r.offset} vs ${offset} (diff ${circ(r.offset, offset, 60 / bpm)})`);
    assert.ok(r.confidence > LOW_CONFIDENCE, `confidence ${r.confidence}`);
  });
}

for (const [bpm, offset] of [[127.6, 0.33], [175.5, 0.29]]) {
  test(`10 minute track at ${bpm} BPM, quiet intro, analysis window starts ~233 s`, async () => {
    const full = kickHat({ bpm, offset, seconds: 600, intro: 233 });
    const prepared = await prepareTrack({ left: full, right: null, sampleRate: SR }, { needBpm: true }, () => false);
    const { mono, sampleRate, startTime } = prepared.bpmInput;
    assert.ok(startTime > 200, `window starts at ${startTime}`);
    const r = await analyzeTempo(mono, sampleRate, { startTime });
    assert.ok(Math.abs(r.bpm - bpm) <= 0.02, `bpm ${r.bpm}`);
    assert.ok(circ(r.offset, offset, 60 / bpm) <= 0.012, `offset error ${circ(r.offset, offset, 60 / bpm)}`);
    assert.ok(r.confidence > LOW_CONFIDENCE, `confidence ${r.confidence}`);
  });
}

test('drum & bass 2-step at 174 BPM is read as 174, not 87', async () => {
  const r = await analyzeTempo(toMono(dnb2step({ bpm: 174, offset: 0.2, seconds: 60 })), SR / 4);
  assert.ok(Math.abs(r.bpm - 174) <= 0.05, `bpm ${r.bpm}`);
  assert.ok(r.confidence > LOW_CONFIDENCE, `confidence ${r.confidence}`);
  assert.ok(circ(r.offset, 0.2, 60 / 174) <= 0.012, `offset ${r.offset}`);
});

test('drum & bass 2-step with a toneless (noise-only) snare is still read as 174', async () => {
  const r = await analyzeTempo(toMono(dnb2step({ bpm: 174, offset: 0.2, seconds: 60, snareTone: 0 })), SR / 4);
  assert.ok(Math.abs(r.bpm - 174) <= 0.05, `bpm ${r.bpm}`);
});

// Slow grooves must never be doubled: only specific drum & bass evidence (an off-beat kick plus
// onsets on both beat parities, or a kick on every fast beat) may double an 80-90 BPM result.
const SLOW = [82, 85, 86, 87, 88.5, 90];
const SLOW_PATTERNS = {
  'kick + offbeat hat': (bpm) => kickHat({ bpm, offset: 0.2, seconds: 60 }),
  'kick + loud offbeat hat': (bpm) => groove({ bpm, kicks: [0, 2, 4, 6], snares: [], hatAmp: 0.8 }),
  'hip-hop (kick 1,3 / snare 2,4 / 8th hats)': (bpm) => hipHop({ bpm }),
  'hip-hop, noise-only snare, loud hats': (bpm) => hipHop({ bpm, snareTone: 0, hatAmp: 0.6 }),
  'syncopated hip-hop (extra kick)': (bpm) => hipHop({ bpm, kicks: [0, 3, 4] }),
};
for (const [name, make] of Object.entries(SLOW_PATTERNS)) {
  test(`${name} at ${SLOW.join(', ')} BPM is never doubled`, async () => {
    for (const bpm of SLOW) {
      const r = await analyzeTempo(toMono(make(bpm)), SR / 4);
      assert.ok(r.bpm !== null && r.bpm < 90.5, `${bpm}: got ${r.bpm}`);
      assert.ok(Math.abs(r.bpm - bpm) <= 0.05, `${bpm}: got ${r.bpm}`);
    }
  });
}

test('genuine slow kick + offbeat-hat tracks keep a confident reading', async () => {
  for (const bpm of [85, 87, 88.5]) {
    const r = await analyzeTempo(toMono(kickHat({ bpm, offset: 0.2, seconds: 60 })), SR / 4);
    assert.ok(r.confidence > LOW_CONFIDENCE, `${bpm}: confidence ${r.confidence}`);
  }
});

test('offset is track-relative when the analysis window starts later', async () => {
  const bpm = 128;
  const full = kickHat({ bpm, offset: 0.13, seconds: 80 });
  const startTime = 12.34;
  const mono = downmixDecimate(full, full, Math.round(startTime * SR), full.length, 4);
  const r = await analyzeTempo(mono, SR / 4, { startTime });
  assert.ok(Math.abs(r.bpm - bpm) <= 0.02, `bpm ${r.bpm}`);
  assert.ok(circ(r.offset, 0.13, 60 / bpm) <= 0.012);
});

test('slow material is folded into 70-180', async () => {
  const mono = toMono(kickHat({ bpm: 60, offset: 0.1, seconds: 60 }));
  const r = await analyzeTempo(mono, SR / 4);
  assert.ok(r.bpm === null || (r.bpm >= 69.9 && r.bpm <= 180.1), `bpm ${r.bpm}`);
});

const notConfident = (r) => r.bpm === null || r.confidence < LOW_CONFIDENCE;

test('a steady 440 Hz sine is not a tempo', async () => {
  const sine = new Float32Array(SR * 30);
  for (let i = 0; i < sine.length; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR);
  const r = await analyzeTempo(toMono(sine), SR / 4);
  assert.ok(notConfident(r), JSON.stringify(r));
});

test('pink-ish noise is not a tempo', async () => {
  const rnd = lcg(99);
  const noise = new Float32Array(SR * 40);
  let b0 = 0;
  let b1 = 0;
  for (let i = 0; i < noise.length; i++) {
    const w = rnd();
    b0 = 0.99 * b0 + 0.1 * w;
    b1 = 0.9 * b1 + 0.3 * w;
    noise[i] = 0.3 * (b0 + b1 + 0.1 * w);
  }
  const r = await analyzeTempo(toMono(noise), SR / 4);
  assert.ok(notConfident(r), JSON.stringify(r));
});

test('hats-only 8th notes at 128 BPM (no beat/offbeat distinction) are not confident', async () => {
  const out = new Float32Array(SR * 60);
  const rnd = lcg(5);
  for (let t = 0.1; t < 60; t += 60 / 128 / 2) addHat(out, t, 0.5, SR, rnd);
  const r = await analyzeTempo(toMono(out), SR / 4);
  assert.ok(notConfident(r), JSON.stringify(r));
});

test('silence and too-short input report no tempo', async () => {
  assert.equal((await analyzeTempo(new Float32Array(SR * 20), SR)).bpm, null);
  assert.equal((await analyzeTempo(new Float32Array(100), SR)).bpm, null);
  assert.equal((await analyzeTempo(null, SR)).bpm, null);
});

test('yieldFn and shouldAbort are honoured', async () => {
  const mono = toMono(kickHat({ bpm: 128, offset: 0.1, seconds: 20 }));
  let n = 0;
  await analyzeTempo(mono, SR / 4, { yieldFn: async () => void n++ });
  assert.ok(n > 3);
  const r = await analyzeTempo(mono, SR / 4, { shouldAbort: () => true });
  assert.equal(r.bpm, null);
});

test('pickAnalysisWindow chooses the loudest region and clamps to the track', () => {
  const rms = new Float32Array(1000).fill(0.01);
  for (let i = 600; i < 700; i++) rms[i] = 1;
  const w = pickAnalysisWindow(rms, 0.5, 30);
  assert.ok(w.start >= 270 && w.start <= 350, `start ${w.start}`);
  assert.equal(Math.round(w.end - w.start), 30);
  assert.deepEqual(pickAnalysisWindow(new Float32Array(10), 0.5, 90), { start: 0, end: 5 });
});
