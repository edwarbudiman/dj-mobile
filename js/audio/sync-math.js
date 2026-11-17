// Pure tempo / beat-grid / sync math. No DOM, no Web Audio.
//
// Grid model: { bpm, offset } in TRACK time. A beat sits at offset + n * (60 / bpm) for every
// integer n (also negative). Pitch changes the playback rate, not the grid.

export const BPM_MIN = 20;
export const BPM_MAX = 300;
export const SEEK_LATENCY = 0.006; // the worklet lands a seek after its 6 ms fade-out

const mod = (x, m) => ((x % m) + m) % m;
const finite = (x) => typeof x === 'number' && Number.isFinite(x);

export function beatPeriod(bpm) {
  return 60 / bpm;
}

/** Effective BPM at a pitch offset in percent (+8 = 8 % faster). */
export function effectiveBpm(baseBpm, pitchPercent) {
  if (!finite(baseBpm) || baseBpm <= 0) return null;
  return baseBpm * (1 + (finite(pitchPercent) ? pitchPercent : 0) / 100);
}

export function pitchToRate(pitchPercent) {
  return 1 + (finite(pitchPercent) ? pitchPercent : 0) / 100;
}

/**
 * Map a pitch fader position 0..1 (0.5 = centre, 1 = top) to percent for a +/-range.
 * Hardware convention: fader DOWN = faster (+), UP = slower (-).
 */
export function faderToPitch(v, rangePercent) {
  const p = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  return (0.5 - p) * 2 * rangePercent;
}

export function pitchToFader(pitchPercent, rangePercent) {
  return Math.min(1, Math.max(0, 0.5 - pitchPercent / (2 * rangePercent)));
}

/** Where `pos` sits in the grid: beat number (integer, may be negative) and phase 0..1 within it. */
export function beatPosition(pos, grid) {
  const p = beatPeriod(grid.bpm);
  const x = (pos - grid.offset) / p;
  const beat = Math.floor(x);
  return { beat, phase: x - beat, bar: mod(beat, 4) };
}

/** Time of the beat nearest to `pos`. */
export function nearestBeatTime(pos, grid) {
  const p = beatPeriod(grid.bpm);
  return grid.offset + Math.round((pos - grid.offset) / p) * p;
}

/** Beat times inside [from, to]. */
export function beatsInRange(grid, from, to) {
  const p = beatPeriod(grid.bpm);
  const out = [];
  const first = Math.ceil((from - grid.offset) / p) + 0; // + 0 turns -0 into 0
  const last = Math.floor((to - grid.offset) / p);
  for (let n = first; n <= last; n++) out.push({ time: grid.offset + n * p, index: n, downbeat: mod(n, 4) === 0 });
  return out;
}

/**
 * Change tempo while keeping the beat nearest `anchorPos` where it is (so the grid does not
 * slide under the playhead). Used for x2, /2 and +/-0.1 nudges.
 */
export function retempo(grid, newBpm, anchorPos) {
  const bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, newBpm));
  const anchor = nearestBeatTime(finite(anchorPos) ? anchorPos : 0, grid);
  const p = beatPeriod(bpm);
  return { ...grid, bpm, offset: mod(anchor, p) };
}

/** Move the grid by `seconds` (positive = later). Offset stays within one beat. */
export function shiftGrid(grid, seconds) {
  return { ...grid, offset: mod(grid.offset + seconds, beatPeriod(grid.bpm)) };
}

/**
 * Tap tempo. taps = [{ pos, t }] (track position in seconds, wall time in seconds), oldest first.
 * Returns { bpm, offset } or null if fewer than 2 taps. When the track is moving, intervals are
 * taken in track time (so pitch is accounted for); otherwise in wall time.
 */
export function tapTempo(taps, moving) {
  if (!taps || taps.length < 2) return null;
  const first = taps[0];
  const last = taps[taps.length - 1];
  const span = moving ? last.pos - first.pos : last.t - first.t;
  const interval = span / (taps.length - 1);
  if (!finite(interval) || interval <= 0) return null;
  const bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, 60 / interval));
  const period = beatPeriod(bpm);
  // Phase: circular mean of each tap's position modulo the beat period.
  let sx = 0;
  let sy = 0;
  for (const tap of taps) {
    const a = (2 * Math.PI * mod(moving ? tap.pos : last.pos, period)) / period;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const phase = mod(Math.atan2(sy, sx) / (2 * Math.PI), 1);
  return { bpm, offset: phase * period };
}

/**
 * Decide the pitch for deck `thisBase` so its effective BPM matches `otherEff`, trying the
 * x1, x2 and x0.5 relationships and picking the smallest pitch change.
 * @returns {{ok:true, pitch:number, range:number, ratio:number}|{ok:false, reason:string}}
 */
export function planSync({ thisBase, otherEff, range = 8, maxRange = 16 }) {
  if (!finite(thisBase) || thisBase <= 0 || !finite(otherEff) || otherEff <= 0) {
    return { ok: false, reason: 'unknown-bpm' };
  }
  let best = null;
  for (const ratio of [1, 2, 0.5]) {
    const pitch = ((otherEff * ratio) / thisBase - 1) * 100;
    if (!best || Math.abs(pitch) < Math.abs(best.pitch)) best = { pitch, ratio };
  }
  const need = Math.abs(best.pitch);
  if (need <= range) return { ok: true, pitch: best.pitch, range, ratio: best.ratio };
  if (need <= maxRange) return { ok: true, pitch: best.pitch, range: maxRange, ratio: best.ratio };
  return { ok: false, reason: 'out-of-range', pitch: best.pitch };
}

/**
 * Seek delta (seconds of track time, signed, at most half a beat) that moves deck "this" onto
 * the same beat phase as the other deck. ratio is the tempo relationship chosen by planSync
 * (this beats `ratio` times per other-deck beat).
 */
export function phaseAlignDelta({ thisPos, thisGrid, otherPos, otherGrid, ratio = 1 }) {
  const other = beatPosition(otherPos, otherGrid).phase;
  const mine = beatPosition(thisPos, thisGrid).phase;
  let candidates;
  if (ratio === 2) candidates = [mod(other * 2, 1)];
  else if (ratio === 0.5) candidates = [other / 2, other / 2 + 0.5];
  else candidates = [other];
  let best = 0;
  let bestAbs = Infinity;
  for (const target of candidates) {
    const d = mod(target - mine + 0.5, 1) - 0.5; // wrap to [-0.5, 0.5)
    if (Math.abs(d) < bestAbs) {
      bestAbs = Math.abs(d);
      best = d;
    }
  }
  return best * beatPeriod(thisGrid.bpm);
}
