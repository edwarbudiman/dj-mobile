// Pure loop math. No DOM, no Web Audio. Times are track seconds.
//
// An auto-loop starts on the beat at or before the heard position and lasts a whole or half number
// of beats of the grid. The worklet (deck-processor.js) does the actual wrapping and the seam
// crossfade; this module only decides WHERE a loop goes.

import { beatPeriod } from './sync-math.js';

// The loop pad sizes. Half a beat is still supported by planLoop / the worklet, but the pad grid has room for
// four sizes plus Exit and the page switch (6 cells of 44 px in 136 px at 667 x 300).
export const LOOP_BEATS = [1, 2, 4, 8];
export const LOOP_XFADE = 0.008; // seconds of seam crossfade (mirrors deck-processor.js)
export const LOOP_MIN_SECONDS = 0.04; // shorter loops are refused

/** 0.5 -> "½", 4 -> "4". */
export function loopLabel(beats) {
  return beats === 0.5 ? '½' : String(beats);
}

const validGrid = (g) => !!g && Number.isFinite(g.bpm) && g.bpm > 0 && Number.isFinite(g.offset);

/** Start of the beat at or before `pos` (never before time 0: the first beat inside the track). */
export function beatAtOrBefore(pos, grid) {
  const p = beatPeriod(grid.bpm);
  let t = grid.offset + Math.floor((pos - grid.offset) / p + 1e-9) * p;
  if (t < 0) t += Math.ceil(-t / p - 1e-9) * p;
  return t;
}

/**
 * Plan an auto-loop.
 * @param {{pos:number, grid:object|null, beats:number, duration:number, active?:{start:number,end:number,beats:number}|null}} o
 *   active: the loop that is running now. Choosing another size keeps its start (like a CDJ: the
 *   in-point stays, the out-point moves); choosing the same size exits.
 * @returns {{ok:true, action:'set', start:number, end:number, beats:number}
 *          |{ok:true, action:'exit'}
 *          |{ok:false, reason:'no-grid'|'too-short'|'near-end'|'bad'}}
 */
export function planLoop({ pos, grid, beats, duration, active = null }) {
  if (active && active.beats === beats) return { ok: true, action: 'exit' };
  if (!validGrid(grid)) return { ok: false, reason: 'no-grid' };
  if (!(beats > 0) || !Number.isFinite(pos) || !(duration > 0)) return { ok: false, reason: 'bad' };
  const length = beats * beatPeriod(grid.bpm);
  if (length < LOOP_MIN_SECONDS) return { ok: false, reason: 'too-short' };
  const start = active ? active.start : beatAtOrBefore(pos, grid);
  const end = start + length;
  if (end + LOOP_XFADE * 2 > duration) return { ok: false, reason: 'near-end' };
  return { ok: true, action: 'set', start, end, beats };
}

/** Plain-language reason for a refused loop (shown in a toast). */
export function loopRefusal(reason) {
  if (reason === 'no-grid') return 'Loops need a beat grid. Set the tempo with Tap first.';
  if (reason === 'near-end') return 'Not enough track left for that loop.';
  if (reason === 'too-short') return 'That loop is too short at this tempo.';
  return "Can't set a loop here.";
}

/** Is `pos` inside the half-open loop [start, end)? */
export function inLoop(pos, loop) {
  return !!loop && pos >= loop.start && pos < loop.end;
}

/** Fold a position into the loop (what a seam wrap does). */
export function wrapIntoLoop(pos, loop) {
  const len = loop.end - loop.start;
  if (!(len > 0)) return pos;
  const n = Math.floor((pos - loop.start) / len);
  return pos - n * len;
}
