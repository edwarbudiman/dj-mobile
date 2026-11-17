// Pure tap / double-tap classification (no DOM). Used by faders and knobs for "double-tap to reset".
//
// A touch is a TAP only if the finger moved less than TAP_MAX_MOVE px and was down for less than
// TAP_MAX_MS. Two such taps close together in time and position make a DOUBLE tap. Anything that
// drags (a fader stroke, a knob turn) is never a tap, so two quick strokes cannot trigger a reset.

export const TAP_MAX_MOVE = 6; // px
export const TAP_MAX_MS = 250;
export const DOUBLE_TAP_MS = 320; // gap between the first tap's release and the second tap's press
export const DOUBLE_TAP_PX = 24; // distance between the two taps

const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

/** Was this touch a tap? down/up: {t (ms), x, y}; maxMove: largest distance from the down point seen. */
export function isTap(down, up, maxMove = 0) {
  const moved = Math.max(maxMove, dist(down.x, down.y, up.x, up.y));
  return moved < TAP_MAX_MOVE && up.t - down.t < TAP_MAX_MS;
}

/**
 * Stateful tracker for one control.
 *   down(t, x, y) at pointerdown, move(x, y) at pointermove, up(t, x, y) at pointerup,
 *   cancel() at pointercancel.
 * up() returns 'double', 'tap' or 'none'.
 */
export function createTapTracker() {
  let current = null;
  let last = null; // previous tap: { t (its release), x, y }
  return {
    down(t, x, y) {
      current = { t, x, y, maxMove: 0 };
    },
    move(x, y) {
      if (current) current.maxMove = Math.max(current.maxMove, dist(current.x, current.y, x, y));
    },
    up(t, x, y) {
      const d = current;
      current = null;
      if (!d || !isTap(d, { t, x, y }, d.maxMove)) {
        last = null;
        return 'none';
      }
      if (last && d.t - last.t <= DOUBLE_TAP_MS && dist(d.x, d.y, last.x, last.y) <= DOUBLE_TAP_PX) {
        last = null;
        return 'double';
      }
      last = { t, x: d.x, y: d.y };
      return 'tap';
    },
    cancel() {
      current = null;
      last = null;
    },
  };
}
