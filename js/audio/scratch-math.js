// Pure scratch math shared by the main thread (platter / waveform input, Deck) and the Node tests.
// The worklet keeps its own copy of the per-sample follower so it has no module dependencies;
// constants that must agree are mirrored there and pinned by tests/processor.test.mjs.

/** Seconds of track time per platter revolution at 33 1/3 rpm (pitch 0). */
export const REV_SECONDS = 60 / (100 / 3); // 1.8
/** Release motor: the rate settles on the play rate with this time constant (95 % in ~3 tau = 90 ms). */
export const MOTOR_TAU = 0.03;
/**
 * Pointer positions closer to the platter centre than this fraction of the radius are ignored for angle:
 * it is exactly the drawn label (platter.js draws it at 0.36 R), where a finger's angle is erratic.
 */
export const DEAD_ZONE = 0.36;

const TWO_PI = Math.PI * 2;

/** Wrap an angle difference into (-pi, pi]. */
export function wrapAngle(a) {
  if (!Number.isFinite(a)) return 0;
  let w = a % TWO_PI;
  if (w > Math.PI) w -= TWO_PI;
  else if (w <= -Math.PI) w += TWO_PI;
  return w;
}

/** Angle in radians (0 = up, clockwise) of the offset (dx, dy) from the centre; y grows downward. */
export function pointerAngle(dx, dy) {
  return Math.atan2(dx, -dy);
}

/** Track position (seconds) -> marker angle in radians in [0, 2pi). */
export function positionToAngle(seconds) {
  const turns = (seconds / REV_SECONDS) % 1;
  return (turns < 0 ? turns + 1 : turns) * TWO_PI;
}

/** Angular travel (radians, clockwise positive) -> track time (seconds, forward positive). */
export function angleToSeconds(radians, revSeconds = REV_SECONDS) {
  return Number.isFinite(radians) ? (radians / TWO_PI) * revSeconds : 0;
}

/**
 * Horizontal drag of the zoomed waveform -> track time. The waveform sticks to the finger: dragging
 * it to the right pulls earlier audio under the playhead, so the position moves backward.
 */
export function pixelsToSeconds(dxPixels, secondsPerPixel) {
  if (!Number.isFinite(dxPixels) || !Number.isFinite(secondsPerPixel) || !(secondsPerPixel > 0)) return 0;
  return -dxPixels * secondsPerPixel;
}

/** pos + delta clamped to [min, max]. Clamping the running position (not the total drag) means a reversal at an edge moves at once, with no dead zone. */
export function applyDelta(pos, delta, min, max) {
  const p = pos + (Number.isFinite(delta) ? delta : 0);
  return p < min ? min : p > max ? max : p;
}

/**
 * Unwraps the angle of a moving pointer about a centre into a running angular delta.
 * Inside `deadZone` x radius the angle is unstable, so the last stable angle is kept and no delta is
 * produced; the first stable sample after that only re-anchors.
 */
export class AngleTracker {
  constructor(deadZone = DEAD_ZONE) {
    this.deadZone = deadZone;
    this.last = null;
  }

  reset() {
    this.last = null;
  }

  /** @returns {number} radians moved since the previous call (clockwise positive), 0 when unknown */
  update(dx, dy, radius) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !(radius > 0)) return 0;
    if (Math.hypot(dx, dy) < this.deadZone * radius) return 0;
    const a = pointerAngle(dx, dy);
    if (this.last === null) {
      this.last = a;
      return 0;
    }
    const d = wrapAngle(a - this.last);
    this.last = a;
    return d;
  }
}

/** Rate during the release spin-up, t seconds after release: exponential approach from `from` to `to`. */
export function motorRate(from, to, t, tau = MOTOR_TAU) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return to + (from - to) * Math.exp(-Math.max(0, t) / tau);
}
