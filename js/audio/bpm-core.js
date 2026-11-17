// Tempo and beat-offset detection. Pure: no DOM, no worker globals, no Web Audio.
//
// Input is a mono signal (already decimated to roughly 8-16 kHz). Pipeline:
//   1. coarse onset-strength envelope (6 ms hop) -> comb-filtered autocorrelation tempo search
//      over 70-180 BPM (octave handling, runner-up margin)
//   2. fine onset envelope (2 ms hop) -> beat tracking by regression: match the onset peak nearest
//      every predicted beat (parabolic sub-hop interpolation), least-squares fit
//      time = c + n * period over progressively longer stages, rejecting outliers
//   3. confidence from the comb margin, on-grid onset contrast, matched-beat fraction and fit residual
// Returns { bpm, offset, confidence }. bpm is null if there is nothing rhythmic to analyse.
// offset is the time (seconds, relative to the track start) of a beat, reduced modulo the period;
// it is computed from a beat near the CENTRE of the analysed region, so period error is not
// extrapolated from the window edge.

export const BPM_LOW = 70;
export const BPM_HIGH = 180;
/** Below this the UI should present the BPM as a guess, not a fact. */
export const LOW_CONFIDENCE = 0.4;

const COARSE_HOP = 0.006;
const FINE_HOP = 0.002;
const COMB_HARMONICS = 4;
const MIN_SECONDS = 6;
const MIN_ONSET_MEAN = 0.002; // mean log-energy flux; a steady tone is ~0, music is >= ~0.02
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Choose the loudest window of `windowSeconds` from per-bucket RMS values.
 * @param {Float32Array} rms  one value per bucket
 * @param {number} secondsPerBucket
 * @returns {{start:number, end:number}} seconds
 */
export function pickAnalysisWindow(rms, secondsPerBucket, windowSeconds = 90) {
  const total = rms.length * secondsPerBucket;
  if (total <= windowSeconds) return { start: 0, end: total };
  const w = Math.max(1, Math.round(windowSeconds / secondsPerBucket));
  let sum = 0;
  for (let i = 0; i < w; i++) sum += rms[i] * rms[i];
  let best = sum;
  let bestAt = 0;
  for (let i = w; i < rms.length; i++) {
    sum += rms[i] * rms[i] - rms[i - w] * rms[i - w];
    if (sum > best) {
      best = sum;
      bestAt = i - w + 1;
    }
  }
  const start = bestAt * secondsPerBucket;
  return { start, end: start + w * secondsPerBucket };
}

/**
 * Onset-strength envelope: log-compressed energy flux of a 400 Hz low-passed band plus half the
 * full band. Frame b describes energy arriving in [b*hop, (b+1)*hop) samples. The first 0.15 s and
 * last 0.05 s are zeroed so a signal that merely starts or stops is not mistaken for a beat.
 * Returns { onset: Float32Array, rate (frames/s), hop (samples) }.
 */
export function onsetEnvelope(mono, sampleRate, hopSeconds = COARSE_HOP, lowOnly = false) {
  const hop = Math.max(1, Math.round(sampleRate * hopSeconds));
  const n = Math.floor(mono.length / hop);
  const eLow = new Float32Array(n);
  const eFull = new Float32Array(n);
  const a = 1 - Math.exp((-2 * Math.PI * 400) / sampleRate);
  let lp = 0;
  let maxLow = 0;
  let maxFull = 0;
  for (let b = 0; b < n; b++) {
    let sl = 0;
    let sf = 0;
    for (let i = b * hop, e = i + hop; i < e; i++) {
      const x = mono[i];
      lp += a * (x - lp);
      sl += lp * lp;
      sf += x * x;
    }
    eLow[b] = sl / hop;
    eFull[b] = sf / hop;
    if (eLow[b] > maxLow) maxLow = eLow[b];
    if (eFull[b] > maxFull) maxFull = eFull[b];
  }
  const rate = sampleRate / hop;
  const onset = new Float32Array(n);
  if (maxFull > 1e-12) {
    const refLow = maxLow > 1e-12 ? maxLow : 1;
    let prevLow = Math.log(1 + (100 * eLow[0]) / refLow);
    let prevFull = Math.log(1 + (100 * eFull[0]) / maxFull);
    for (let b = 1; b < n; b++) {
      const lo = Math.log(1 + (100 * eLow[b]) / refLow);
      const fu = Math.log(1 + (100 * eFull[b]) / maxFull);
      onset[b] = Math.max(0, lo - prevLow) + (lowOnly ? 0 : 0.5 * Math.max(0, fu - prevFull));
      prevLow = lo;
      prevFull = fu;
    }
    onset.fill(0, 0, Math.min(n, Math.ceil(0.15 * rate)));
    onset.fill(0, Math.max(0, n - Math.ceil(0.05 * rate)));
    const sm = new Float32Array(n);
    for (let b = 1; b < n - 1; b++) sm[b] = 0.25 * onset[b - 1] + 0.5 * onset[b] + 0.25 * onset[b + 1];
    return { onset: sm, rate, hop };
  }
  return { onset, rate, hop };
}

function interp(arr, x) {
  if (x <= 0) return arr[0];
  const i = Math.floor(x);
  if (i >= arr.length - 1) return arr[arr.length - 1];
  const f = x - i;
  return arr[i] * (1 - f) + arr[i + 1] * f;
}

const mean = (arr) => {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return arr.length ? s / arr.length : 0;
};

const median = (arr) => {
  const s = [...arr].sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : 0;
};

/**
 * Beat tracking by regression on the fine envelope. P0 is the coarse period (seconds).
 * Returns { period, ref (a beat time near the window centre, seconds from window start),
 *           hits (matched fraction), rms (residual seconds), contrast } or null.
 */
export function trackBeats(env, P0, lenSec) {
  const { onset, rate: fe } = env;
  const N = onset.length;
  const at = (t) => interp(onset, t * fe - 0.5);
  const meanAll = mean(onset);
  if (!(meanAll > 0)) return null;

  // Initial phase from the first stage only, where the coarse period cannot have drifted far.
  const E1 = Math.min(12, lenSec);
  const steps = Math.max(8, Math.round(P0 * fe));
  let c = 0;
  let bestS = -Infinity;
  for (let s = 0; s < steps; s++) {
    const ph = (s / steps) * P0;
    let sum = 0;
    for (let t = ph; t < E1; t += P0) sum += at(t);
    if (sum > bestS) {
      bestS = sum;
      c = ph;
    }
  }
  let P = P0;

  const fitStage = (E) => {
    const radius = Math.max(2, Math.min(Math.round(0.2 * P * fe), Math.round(0.045 * fe)));
    const nMin = Math.ceil((0.05 - c) / P);
    const nMax = Math.floor((E - 0.05 - c) / P);
    const cand = [];
    for (let n = nMin; n <= nMax; n++) {
      const f0 = Math.round((c + n * P) * fe - 0.5);
      let k = -1;
      let v = -1;
      for (let j = Math.max(1, f0 - radius); j <= Math.min(N - 2, f0 + radius); j++) {
        if (onset[j] > v) {
          v = onset[j];
          k = j;
        }
      }
      if (k >= 0) cand.push({ n, k, v });
    }
    const predicted = nMax - nMin + 1;
    if (cand.length < 4) return null;
    const thr = Math.max(0.3 * median(cand.map((q) => q.v)), 1.5 * meanAll);
    let pts = [];
    for (const q of cand) {
      if (q.v < thr) continue;
      const y0 = onset[q.k - 1];
      const y1 = onset[q.k];
      const y2 = onset[q.k + 1];
      const d = y0 - 2 * y1 + y2;
      const delta = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : 0;
      pts.push({ n: q.n, t: (q.k + delta + 0.5) / fe, w: q.v });
    }
    if (pts.length < 4) return null;
    const fit = (list) => {
      let sw = 0;
      let sn = 0;
      let st = 0;
      for (const p of list) {
        sw += p.w;
        sn += p.w * p.n;
        st += p.w * p.t;
      }
      const nb = sn / sw;
      const tb = st / sw;
      let num = 0;
      let den = 0;
      for (const p of list) {
        num += p.w * (p.n - nb) * (p.t - tb);
        den += p.w * (p.n - nb) * (p.n - nb);
      }
      if (!(den > 0)) return null;
      const per = num / den;
      return { P: per, c: tb - per * nb };
    };
    let f = fit(pts);
    if (!f) return null;
    // One round of outlier rejection (median absolute deviation of the residuals).
    const res = pts.map((p) => p.t - (f.c + p.n * f.P));
    const mad = median(res.map((r) => Math.abs(r - median(res))));
    const limit = Math.max(4 * 1.4826 * mad, 0.004);
    const kept = pts.filter((p, i) => Math.abs(res[i] - median(res)) <= limit);
    if (kept.length >= 4 && kept.length < pts.length) {
      const f2 = fit(kept);
      if (f2) {
        f = f2;
        pts = kept;
      }
    }
    let ss = 0;
    for (const p of pts) ss += (p.t - (f.c + p.n * f.P)) ** 2;
    return { ...f, used: pts.length, predicted, rms: Math.sqrt(ss / pts.length) };
  };

  const stages = [...new Set([E1, Math.min(32, lenSec), lenSec])].sort((p, q) => p - q);
  let last = null;
  for (const E of stages) {
    for (let iter = 0; iter < 2; iter++) {
      const r = fitStage(E);
      if (!r) break;
      // The fit's reference beat can be extrapolated far from the stage: move it next to the stage centre.
      P = r.P;
      c = r.c + Math.round((E / 2 - r.c) / P) * P;
      last = r;
    }
  }
  if (!last) return null;

  // On-grid contrast: onset at the fitted beat times relative to the overall mean.
  let s = 0;
  let cnt = 0;
  for (let t = c - Math.floor(c / P) * P; t < lenSec - 0.05; t += P) {
    s += at(t);
    cnt++;
  }
  const contrast = cnt ? s / cnt / meanAll : 0;
  const ref = c + Math.round((lenSec / 2 - c) / P) * P;
  return { period: P, ref, hits: last.used / Math.max(1, last.predicted), rms: last.rms, contrast };
}

// Onset strength at every beat of a grid (ref + n * period + shift): the local maximum within
// +/-12 % of a period. Returns [{ n, parity (0|1), v }].
function beatStrengths(env, ref, period, lenSec, shift = 0) {
  const { onset, rate: fe } = env;
  const radius = Math.max(1, Math.round(0.12 * period * fe));
  const nMin = Math.ceil((0.1 - ref - shift) / period);
  const nMax = Math.floor((lenSec - 0.1 - ref - shift) / period);
  const out = [];
  for (let n = nMin; n <= nMax; n++) {
    const f0 = Math.round((ref + shift + n * period) * fe - 0.5);
    let v = 0;
    for (let j = Math.max(0, f0 - radius); j <= Math.min(onset.length - 1, f0 + radius); j++) if (onset[j] > v) v = onset[j];
    out.push({ n, parity: ((n % 2) + 2) % 2, v });
  }
  return out;
}

const percentile = (vals, q) => {
  const s = vals.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
};

// Share of beats of each parity (even / odd beat) whose strength reaches `thr`.
function parityShare(list, thr) {
  const tot = [0, 0];
  const hit = [0, 0];
  for (const b of list) {
    tot[b.parity]++;
    if (b.v >= thr) hit[b.parity]++;
  }
  return [tot[0] ? hit[0] / tot[0] : 0, tot[1] ? hit[1] / tot[1] : 0];
}

/**
 * Is a pulse train at `fastPeriod` really the tempo, or is it a groove at HALF that tempo?
 * Looks at what sits on the fast grid (ref = a fast beat time):
 *   - fourOnFloor: kicks (a 400 Hz low-band onset) on both even and odd fast beats. A slow groove
 *     with only offbeat hats has kicks on every other fast beat at most.
 *   - twoStep: a drum & bass bar (kick 1, snare 2, kick on the "and" of 3, snare 4): a low-band
 *     kick BETWEEN fast beats (an off-beat kick) AND strong full-band onsets (snares) on one beat
 *     parity with a mixed pattern on the other.
 *   - slowDecisive: full-band strength alternates strong / weak between even and odd fast beats
 *     (kick or kick + snare on every second beat, hats between): clearly the slower groove.
 * A plain offbeat hat or a hip-hop backbeat (kick 1 and 3, snare 2 and 4, eighth hats) satisfies
 * neither double-tempo test, so it is never doubled.
 */
export function drumEvidence(fine, fineLow, ref, fastPeriod, lenSec) {
  const full = beatStrengths(fine, ref, fastPeriod, lenSec);
  const low = beatStrengths(fineLow, ref, fastPeriod, lenSec);
  const half = beatStrengths(fineLow, ref, fastPeriod, lenSec, fastPeriod / 2);
  if (full.length < 8) return { double: false, slowDecisive: false };
  const fullThr = 0.2 * percentile(full.map((b) => b.v), 0.9);
  const lowThr = 0.5 * percentile([...low, ...half].map((b) => b.v), 0.9);
  const fullShare = parityShare(full, fullThr);
  const lowShare = parityShare(low, lowThr);
  const halfShare = half.length ? half.filter((b) => b.v >= lowThr).length / half.length : 0;
  const fourOnFloor = lowThr > 0 && Math.min(...lowShare) >= 0.7;
  const twoStep = lowThr > 0 && halfShare >= 0.15 && Math.min(...fullShare) >= 0.3 && Math.max(...fullShare) >= 0.35;
  const slowDecisive = Math.max(...fullShare) >= 0.8 && Math.min(...fullShare) <= 0.3;
  return { double: fourOnFloor || twoStep, slowDecisive, fullShare, lowShare, halfShare };
}

/**
 * @param {Float32Array} mono
 * @param {number} sampleRate  rate of `mono`
 * @param {{startTime?:number, yieldFn?:()=>Promise<void>, shouldAbort?:()=>boolean}} [opts]
 *        startTime: where mono begins in the track (seconds), so the offset is track-relative.
 * @returns {Promise<{bpm:number|null, offset:number, confidence:number}>}
 */
export async function analyzeTempo(mono, sampleRate, opts = {}) {
  const startTime = opts.startTime || 0;
  const yieldFn = opts.yieldFn || null;
  const none = { bpm: null, offset: 0, confidence: 0 };
  if (!mono || mono.length / sampleRate < MIN_SECONDS) return none;
  const lenSec = mono.length / sampleRate;

  const { onset, rate: fe } = onsetEnvelope(mono, sampleRate, COARSE_HOP);
  const N = onset.length;
  // Relative-energy gate: a steady tone or silence has no onsets worth speaking of.
  if (!(mean(onset) >= MIN_ONSET_MEAN)) return none;
  const mu = mean(onset);
  const x = new Float32Array(N);
  let energy = 0;
  for (let i = 0; i < N; i++) {
    x[i] = onset[i] - mu;
    energy += x[i] * x[i];
  }
  if (!(energy > 1e-9)) return none;

  // Unbiased autocorrelation out to the longest lag the comb will look at.
  const maxLag = Math.min(N - 2, Math.ceil((COMB_HARMONICS * fe * 60) / (BPM_LOW * 0.97)) + 2);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < N; i++) s += x[i] * x[i + lag];
    ac[lag] = s / (N - lag);
    if ((lag & 31) === 31) {
      if (opts.shouldAbort && opts.shouldAbort()) return none;
      if (yieldFn) await yieldFn();
    }
  }
  const ac0 = ac[0];

  const comb = (bpm) => {
    const T = (fe * 60) / bpm;
    let s = 0;
    for (let k = 1; k <= COMB_HARMONICS; k++) {
      const lag = k * T;
      if (lag > maxLag) break;
      s += interp(ac, lag);
    }
    return s / COMB_HARMONICS;
  };
  // A pulse train and the same train at half speed (every other beat) autocorrelate alike, so a
  // candidate is penalised when its own half-period is also a strong pulse (a faster pulse exists).
  const score = (bpm) => comb(bpm) - 0.5 * Math.max(0, interp(ac, (fe * 30) / bpm));

  const cands = [];
  for (let bpm = BPM_LOW; bpm <= BPM_HIGH; bpm += 0.25) cands.push({ bpm, s: score(bpm) });
  let best = cands[0];
  for (const c of cands) if (c.s > best.s) best = c;
  // Margin over the best candidate that is NOT an octave (or the same peak) of the winner. Measured
  // on the plain comb (no octave penalty), so an ambiguous pulse train such as steady 8th-note
  // hats, where 128 and 85.3 BPM explain the onsets equally well, ends up with margin ~0.
  const combBest = comb(best.bpm);
  let runner = 0;
  for (const c of cands) {
    const r = c.bpm / best.bpm;
    const octave = [0.5, 1, 2].some((o) => Math.abs(r / o - 1) < 0.06);
    if (!octave) {
      const v = comb(c.bpm);
      if (v > runner) runner = v;
    }
  }
  const margin = combBest > 0 ? clamp01((combBest - runner) / combBest) : 0;

  // Fine scan around the winner for the starting period of the regression.
  let bpm0 = best.bpm;
  let fineBest = -Infinity;
  for (let b = best.bpm - 0.6; b <= best.bpm + 0.6; b += 0.01) {
    const s = score(b);
    if (s > fineBest) {
      fineBest = s;
      bpm0 = b;
    }
  }
  while (bpm0 < BPM_LOW) bpm0 *= 2;
  while (bpm0 >= BPM_HIGH * 1.0001) bpm0 /= 2;

  if (opts.shouldAbort && opts.shouldAbort()) return none;
  if (yieldFn) await yieldFn();
  const fine = onsetEnvelope(mono, sampleRate, FINE_HOP);
  let tr = trackBeats(fine, 60 / bpm0, lenSec);
  // Octave check for 80-90 BPM results (the doubled tempo would be 160-180, drum & bass territory).
  // Autocorrelation cannot separate a slow groove from the same groove at double speed, so the
  // doubled tempo is accepted ONLY on specific drum evidence (see drumEvidence). Otherwise the slower
  // tempo is kept, and if neither hypothesis is clearly better the confidence is lowered so the UI
  // shows the doubt (x2 in the Grid popover is one tap away).
  let ambiguous = false;
  if (tr && bpm0 > 80 && bpm0 * 2 <= BPM_HIGH) {
    // Autocorrelation chose the slower octave: double it only on drum & bass evidence.
    const fast = trackBeats(fine, 60 / (bpm0 * 2), lenSec);
    if (fast) {
      const lowEnv = onsetEnvelope(mono, sampleRate, FINE_HOP, true);
      const ev = drumEvidence(fine, lowEnv, fast.ref, fast.period, lenSec);
      if (ev.double && fast.rms / fast.period <= 0.03) {
        tr = fast;
        bpm0 *= 2;
      } else if (!ev.slowDecisive && comb(bpm0 * 2) >= 0.9 * comb(bpm0)) {
        ambiguous = true;
      }
    }
  } else if (tr && bpm0 > 160 && bpm0 / 2 >= BPM_LOW) {
    // Autocorrelation chose the fast octave: keep it only if the drums show a fast pulse;
    // a clear slow groove (strong / weak alternation on the fast beats) is halved.
    const lowEnv = onsetEnvelope(mono, sampleRate, FINE_HOP, true);
    const ev = drumEvidence(fine, lowEnv, tr.ref, tr.period, lenSec);
    if (!ev.double) {
      const slow = ev.slowDecisive ? trackBeats(fine, 120 / bpm0, lenSec) : null;
      if (slow) {
        tr = slow;
        bpm0 /= 2;
      } else if (comb(bpm0 / 2) >= 0.9 * comb(bpm0)) {
        ambiguous = true;
      }
    }
  }
  if (!tr) return { bpm: bpm0, offset: 0, confidence: 0 };

  const bpm = 60 / tr.period;
  const refTrack = startTime + tr.ref;
  const offset = ((refTrack % tr.period) + tr.period) % tr.period;

  // Confidence: every factor must be healthy (geometric mean, so any zero zeroes it).
  const sMargin = clamp01((margin - 0.1) / 0.5);
  const sContrast = clamp01((tr.contrast - 2) / 4);
  const sHits = clamp01((tr.hits - 0.4) / 0.5);
  const sFit = clamp01(1 - tr.rms / tr.period / 0.04);
  let confidence = Math.pow(sMargin * sContrast * sHits * sFit, 0.25);
  const strength = clamp01(comb(bpm0) / ac0);
  if (strength < 0.05) confidence = 0;
  if (ambiguous) confidence = Math.min(confidence, 0.9 * LOW_CONFIDENCE);

  return { bpm, offset, confidence };
}
