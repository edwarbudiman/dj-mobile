// Built-in demo loops, synthesized from nothing: no samples, no files, nothing copyrighted.
//
// Plain Float32 synthesis, rendered one bar at a time with a yield between bars so the UI never
// freezes (see renderDemo). Each demo is a short evolving house track: drums (kick, clap, hats),
// a bass line, a syncopated chord stab with an echo and a slow pad, arranged in 4-bar sections with a
// breakdown and a riser. The kick sits exactly on beat 1 of bar 1, so the grid is known without any
// analysis: offset 0 and the BPM below. Everything is sidechain-ducked by the kick and soft-limited,
// then peak-normalised to -1 dBFS, so it cannot clip.
//
// Pure: no DOM, no Web Audio (unit-tested in Node).

export const DEMO_RATE = 44100;
export const DEMO_PEAK = 0.89; // -1 dBFS

const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
const TAU = Math.PI * 2;

/**
 * Section flags, one letter each:  k kick · h hats · c clap · o open hat · b bass · s stab · p pad · r riser
 * (the riser plays in the last bar of its section). One string per 4 bars.
 */
export const DEMOS = [
  {
    id: 'demo:night-drive',
    name: 'Night Drive',
    bpm: 122,
    bars: 32, // 62.95 s
    seed: 12201,
    chords: [
      { root: 33, notes: [57, 60, 64, 67] }, // Am7
      { root: 29, notes: [53, 57, 60, 64] }, // Fmaj7
      { root: 36, notes: [55, 60, 64, 67] }, // C/G
      { root: 31, notes: [55, 59, 62, 64] }, // G6
    ],
    sections: ['kh', 'khc', 'khcbo', 'khcbos', 'khcbosp', 'hpr', 'khcbosp', 'khcbo'],
    bass: [[2, 2, 0], [6, 2, 0], [10, 1, 0], [11, 1, 12], [14, 2, 0]], // [16th step, length in steps, semitones up]
    stabs: [3, 10],
  },
  {
    id: 'demo:neon-floor',
    name: 'Neon Floor',
    bpm: 128,
    bars: 40, // 75.0 s
    seed: 12802,
    chords: [
      { root: 38, notes: [50, 53, 57, 60, 64] }, // Dm9
      { root: 34, notes: [46, 53, 57, 62] }, // Bbmaj7
      { root: 41, notes: [53, 57, 60, 64] }, // Fmaj7
      { root: 36, notes: [52, 55, 60, 64] }, // C
    ],
    sections: ['kh', 'khc', 'khcb', 'khcbo', 'khcbos', 'hpr', 'khcbosp', 'khcbos', 'hpr', 'khcbosp'],
    bass: [[0, 2, 0], [3, 1, 0], [6, 2, 12], [8, 2, 0], [11, 1, 0], [14, 2, 7]],
    stabs: [6, 9, 14],
  },
];

function makeRnd(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2147483648 - 1; // -1 .. 1
  };
}

const onePole = (fc, sr) => 1 - Math.exp((-TAU * fc) / sr);
const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The render hands control back to the event loop whenever a slice has run this long (ms). */
export const YIELD_BUDGET_MS = 6;

/** Duration in seconds of a demo (a whole number of bars). */
export function demoDuration(def) {
  return (def.bars * 4 * 60) / def.bpm;
}

/**
 * Render a demo.
 * @param {typeof DEMOS[number]} def
 * @param {{sampleRate?:number, yieldFn?:()=>Promise<void>, onProgress?:(fraction:number)=>void, shouldAbort?:()=>boolean,
 *          clock?:()=>number}} [opts]  clock: milliseconds source for the yield budget (injectable for deterministic tests)
 * @returns {Promise<null|{left:Float32Array,right:Float32Array,sampleRate:number,length:number,duration:number,bpm:number,offset:number}>}
 *          null when aborted
 */
export async function renderDemo(def, { sampleRate = DEMO_RATE, yieldFn = defaultYield, onProgress, shouldAbort, clock = now } = {}) {
  const sr = sampleRate;
  const spb = 60 / def.bpm;
  const length = Math.round(def.bars * 4 * spb * sr);
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  const rnd = makeRnd(def.seed);
  const beatSamples = spb * sr;

  // Time-budgeted yielding: every voice checks the clock at a stride of a few thousand samples, so no slice
  // of work (kick, a bar of pad, the master pass...) can hold the thread much longer than YIELD_BUDGET_MS.
  let sliceStart = clock();
  const pace = async () => {
    if (clock() - sliceStart >= YIELD_BUDGET_MS) {
      await yieldFn();
      sliceStart = clock();
    }
  };

  // sidechain: everything but the drums dips right after each kick (only where there is a kick)
  let ducking = false;
  const duck = (i) => (ducking ? 1 - 0.55 * Math.exp((-(i - Math.floor(i / beatSamples) * beatSamples) / sr) * 14) : 1);

  const add = (i, v, pl, pr) => {
    L[i] += v * pl;
    R[i] += v * pr;
  };
  const sec = (t) => Math.round(t * sr);

  function kick(t, vel) {
    const i0 = sec(t);
    const n = Math.min(Math.floor(0.42 * sr), length - i0);
    let ph = 0;
    for (let j = 0; j < n; j++) {
      const tt = j / sr;
      ph += (TAU * (46 + 118 * Math.exp(-tt * 34))) / sr;
      let s = Math.sin(ph) * Math.exp(-tt * 6.2);
      if (tt < 0.003) s += rnd() * 0.22 * (1 - tt / 0.003);
      s = Math.tanh(s * 1.4) * 0.72 * vel;
      add(i0 + j, s, 1, 1);
    }
  }

  function clap(t, vel) {
    const i0 = sec(t);
    const n = Math.min(Math.floor(0.26 * sr), length - i0);
    const aHi = onePole(3200, sr);
    const aLo = onePole(950, sr);
    let hiL = 0, loL = 0, hiR = 0, loR = 0;
    for (let j = 0; j < n; j++) {
      const tt = j / sr;
      const pulses = tt < 0.034 ? Math.exp(-(tt % 0.011) * 260) : 0;
      const env = (pulses ? pulses * 0.8 : 0) + Math.exp(-tt * 20) * (tt >= 0.034 ? 0.7 : 0.25);
      const xl = rnd();
      const xr = rnd();
      hiL += aHi * (xl - hiL);
      loL += aLo * (xl - loL);
      hiR += aHi * (xr - hiR);
      loR += aLo * (xr - loR);
      add(i0 + j, (hiL - loL) * env * 0.9 * vel, 1, 0);
      add(i0 + j, (hiR - loR) * env * 0.9 * vel, 0, 1);
    }
  }

  function hat(t, vel, open, pan) {
    const i0 = sec(t);
    const dur = open ? 0.24 : 0.07;
    const n = Math.min(Math.floor(dur * sr), length - i0);
    const a = onePole(6500, sr);
    const k = open ? 17 : 75;
    let lp = 0;
    const pl = 0.5 - pan * 0.4;
    const pr = 0.5 + pan * 0.4;
    for (let j = 0; j < n; j++) {
      const x = rnd();
      lp += a * (x - lp);
      add(i0 + j, (x - lp) * Math.exp((-j / sr) * k) * vel * 0.6, pl * 1.4, pr * 1.4);
    }
  }

  function bassNote(t, hz, dur, vel, progress) {
    const i0 = sec(t);
    const n = Math.min(Math.floor((dur + 0.05) * sr), length - i0);
    let p = 0, sp = 0, f1 = 0, f2 = 0;
    const base = 230 + 650 * progress;
    for (let j = 0; j < n; j++) {
      const tt = j / sr;
      p += hz / sr;
      if (p >= 1) p -= 1;
      sp += (TAU * hz) / sr;
      const a = onePole(base * (1 + 2.6 * Math.exp(-tt * 13)), sr);
      f1 += a * (2 * p - 1 - f1);
      f2 += a * (f1 - f2);
      const env = Math.min(1, j / (0.002 * sr)) * (tt < dur ? 1 : Math.max(0, 1 - (tt - dur) / 0.05)) * Math.exp(-tt * 2.6);
      const s = (f2 * 0.8 + Math.sin(sp) * 0.55) * env * 0.62 * vel * duck(i0 + j);
      add(i0 + j, s, 1, 1);
    }
  }

  async function stabVoice(t, notes, vel, flip) {
    const i0 = sec(t);
    const n = Math.min(Math.floor(0.36 * sr), length - i0);
    for (let v = 0; v < notes.length; v++) {
      await pace();
      const hz = midiHz(notes[v] + 12);
      let p1 = 0, p2 = 0.37, f1 = 0, f2 = 0;
      const pan = (v % 2 ? 1 : -1) * (flip ? -1 : 1) * 0.3 + 0.5;
      for (let j = 0; j < n; j++) {
        if ((j & 4095) === 4095) await pace();
        const tt = j / sr;
        p1 += (hz * 0.997) / sr;
        p2 += (hz * 1.004) / sr;
        if (p1 >= 1) p1 -= 1;
        if (p2 >= 1) p2 -= 1;
        const a = onePole(900 + 2600 * Math.exp(-tt * 12), sr);
        f1 += a * ((p1 < 0.5 ? 1 : -1) + (p2 < 0.5 ? 1 : -1) - f1);
        f2 += a * (f1 - f2);
        const env = Math.min(1, j / (0.003 * sr)) * Math.exp(-tt * 9.5);
        const s = f2 * env * 0.12 * vel * duck(i0 + j);
        add(i0 + j, s, 1 - pan, pan);
      }
    }
  }

  async function pad(t0, dur, notes, progress, bar) {
    const lead = 0.25; // overlap into the neighbouring bars so chords melt into each other
    const a = sec(t0 - lead);
    const b = Math.min(length, sec(t0 + dur + lead));
    const fadeN = 0.45 * sr;
    const first = Math.max(0, a);
    const h2 = 0.12 + 0.3 * progress;
    for (let v = 0; v < notes.length; v++) {
      const hz = midiHz(notes[v]);
      const w = TAU / sr;
      let pa = (v * 1.7) % TAU, pb = (v * 0.9) % TAU, pc = 0;
      const pan = 0.5 + (v % 2 ? 1 : -1) * 0.28;
      const lfoRate = 0.13 + v * 0.021;
      for (let i = first; i < b; i++) {
        if (((i - first) & 2047) === 2047) await pace();
        const k = i - a;
        const tail = b - i;
        const fin = k < fadeN ? Math.sin((k / fadeN) * Math.PI * 0.5) : 1;
        const fout = tail < fadeN ? Math.sin((tail / fadeN) * Math.PI * 0.5) : 1;
        pa += w * hz * 0.9975;
        pb += w * hz * 1.0027;
        pc += w * hz * 2;
        const lfo = 1 + 0.18 * Math.sin(w * lfoRate * i + bar);
        const s = (Math.sin(pa) + Math.sin(pb) + h2 * Math.sin(pc)) * fin * fin * fout * fout * lfo * 0.075 * duck(i);
        add(i, s, 1 - pan, pan);
      }
    }
  }

  async function riser(t0, dur) {
    const i0 = sec(t0);
    const n = Math.min(Math.floor(dur * sr), length - i0);
    let lpL = 0, lpR = 0;
    for (let j = 0; j < n; j++) {
      if ((j & 4095) === 4095) await pace();
      const x = j / n;
      const a = onePole(300 * Math.pow(30, x), sr);
      lpL += a * (rnd() - lpL);
      lpR += a * (rnd() - lpR);
      const env = x * x * 0.3;
      add(i0 + j, lpL * env, 1, 0);
      add(i0 + j, lpR * env, 0, 1);
    }
  }

  for (let bar = 0; bar < def.bars; bar++) {
    if (shouldAbort && shouldAbort()) return null;
    const flags = def.sections[Math.min(def.sections.length - 1, Math.floor(bar / 4))];
    const has = (c) => flags.includes(c);
    const chord = def.chords[bar % def.chords.length];
    const t0 = bar * 4 * spb;
    const progress = bar / def.bars;
    ducking = has('k');

    for (let beat = 0; beat < 4; beat++) {
      const t = t0 + beat * spb;
      if (has('k')) kick(t, 1);
      if (has('c') && (beat === 1 || beat === 3)) clap(t, 0.8);
      if (has('h')) {
        const side = beat % 2 ? 1 : -1;
        hat(t + spb * 0.5, has('o') ? 0.8 : 0.55, has('o'), side * 0.5);
        hat(t + spb * 0.25, 0.16, false, -side * 0.4);
        hat(t + spb * 0.75, 0.2, false, side * 0.4);
      }
      await pace();
    }
    if (has('b')) {
      for (const [step, len, up] of def.bass) {
        bassNote(t0 + (step * spb) / 4, midiHz(chord.root + up), (len * spb) / 4, step === 0 ? 1 : 0.9, progress);
        await pace();
      }
    }
    if (has('s')) {
      for (let k = 0; k < def.stabs.length; k++) {
        const t = t0 + (def.stabs[k] * spb) / 4;
        await stabVoice(t, chord.notes, 1, k % 2 === 1);
        await stabVoice(t + spb * 0.75, chord.notes, 0.38, k % 2 === 0); // echo, dotted eighth
        await stabVoice(t + spb * 1.5, chord.notes, 0.16, k % 2 === 1);
      }
    }
    if (has('p')) await pad(t0, 4 * spb, chord.notes, progress, bar);
    if (has('r') && bar % 4 === 3) await riser(t0, 4 * spb);

    if (onProgress) onProgress((bar + 1) / def.bars);
    await pace();
  }

  // master: soft-limit the sum, then normalise the peak to -1 dBFS and fade the very ends
  let peak = 0;
  for (let i = 0; i < length; i++) {
    if ((i & 32767) === 32767) {
      if (shouldAbort && shouldAbort()) return null;
      await pace();
    }
    const l = Math.tanh(L[i] * 1.1);
    const r = Math.tanh(R[i] * 1.1);
    L[i] = l;
    R[i] = r;
    const m = Math.max(Math.abs(l), Math.abs(r));
    if (m > peak) peak = m;
  }
  const g = peak > 0 ? DEMO_PEAK / peak : 1;
  const fadeEnd = Math.floor(0.03 * sr);
  for (let i = 0; i < length; i++) {
    if ((i & 32767) === 32767) await pace();
    const tail = length - 1 - i;
    const f = g * (tail < fadeEnd ? tail / fadeEnd : 1);
    L[i] *= f;
    R[i] *= f;
  }
  return { left: L, right: R, sampleRate: sr, length, duration: length / sr, bpm: def.bpm, offset: 0 };
}
