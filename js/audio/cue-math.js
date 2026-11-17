// Pure hot-cue helpers. No DOM, no Web Audio.

import { LOW_CONFIDENCE } from './bpm-core.js';
import { nearestBeatTime } from './sync-math.js';

export const HOT_CUE_COUNT = 4;

/** True when the grid is trustworthy enough to snap to (a manual / tap grid has confidence 1). */
export function confidentGrid(grid) {
  return !!grid && Number.isFinite(grid.bpm) && grid.bpm > 0 && Number.isFinite(grid.offset) && (grid.confidence ?? 1) >= LOW_CONFIDENCE;
}

/**
 * Where a hot cue set at `pos` lands: the nearest beat on a confident grid, otherwise exactly `pos`.
 * Always inside [0, duration].
 */
export function hotCueTime(pos, grid, duration) {
  const p = Number.isFinite(pos) ? Math.min(Math.max(pos, 0), duration) : 0;
  if (!confidentGrid(grid)) return p;
  const t = nearestBeatTime(p, grid);
  return t >= 0 && t <= duration ? t : p;
}

/** Library metadata -> a clean array of HOT_CUE_COUNT entries (finite seconds inside the track, or null). */
export function sanitizeHotCues(value, duration = Infinity) {
  const out = new Array(HOT_CUE_COUNT).fill(null);
  if (!Array.isArray(value)) return out;
  for (let i = 0; i < HOT_CUE_COUNT; i++) {
    const t = value[i];
    if (typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= duration) out[i] = t;
  }
  return out;
}
