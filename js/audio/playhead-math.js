// Pure playhead helpers shared by the main thread (and Node tests).
// The worklet keeps its own copy of the inner-loop math so it has no module dependencies.

import { clamp } from './mixer-math.js';

/**
 * Estimate the current track position (seconds) from a worklet position report.
 * report = { pos, ctxTime, speed } where speed is track-seconds per context-second
 * (signed; 0 when stopped) and ctxTime is the AudioContext time of the report.
 */
export function estimatePosition(report, now, duration) {
  if (!report) return 0;
  const p = report.pos + (now - report.ctxTime) * report.speed;
  return clamp(p, 0, duration > 0 ? duration : 0);
}

/** True when two positions are within tol seconds. */
export function isNear(a, b, tol = 0.02) {
  return Math.abs(a - b) <= tol;
}
