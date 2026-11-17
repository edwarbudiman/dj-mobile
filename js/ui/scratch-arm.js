// Pure state machine for the portrait "arming" of a scratch touch (no DOM, unit-tested).
//
// In the stacked portrait layout the page scrolls vertically, so a touch on the platter or the zoom
// waveform must not grab the record straight away. It is ARMED, and then:
//   - a first movement of at least ARM_MOVE_PX decides: mostly horizontal (waveform) / around the vinyl
//     rather than along a radius (platter) engages the grab; anything else is left to the page (cancel);
//   - holding still for ARM_HOLD_MS engages the grab on the PLATTER only. On the waveform a hold alone
//     never grabs: it needs sideways movement, so a resting thumb or a slow scroll never stops the music;
//   - the pointer going up / cancelled at any time ends the arming for good (`armUp`), so a timer that
//     fires after the finger has left can never grab.

export const ARM_HOLD_MS = 250;
export const ARM_MOVE_PX = 10;

/** @param {'platter'|'wave'} kind @param {{cx:number,cy:number}|null} geo platter centre */
export function armStart(kind, x0, y0, geo = null) {
  return { kind, x0, y0, x: x0, y: y0, geo, down: true };
}

/** The pointer is no longer down (pointerup, pointercancel, lost capture). */
export function armUp(a) {
  a.down = false;
}

/** @returns {'pending'|'engage'|'cancel'} */
export function armMove(a, x, y) {
  if (!a.down) return 'cancel';
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'pending';
  a.x = x;
  a.y = y;
  const dx = x - a.x0;
  const dy = y - a.y0;
  if (Math.hypot(dx, dy) < ARM_MOVE_PX) return 'pending';
  let scratchLike = Math.abs(dy) <= 1.5 * Math.abs(dx); // mostly horizontal
  if (scratchLike && a.kind === 'platter' && a.geo) {
    const rx = a.x0 - a.geo.cx;
    const ry = a.y0 - a.geo.cy;
    const rl = Math.hypot(rx, ry) || 1;
    const tangential = Math.abs((dx * -ry + dy * rx) / rl);
    const radial = Math.abs((dx * rx + dy * ry) / rl);
    scratchLike = tangential >= radial; // around the vinyl, not in or out
  }
  return scratchLike ? 'engage' : 'cancel';
}

/** The hold timer fired. @returns {'pending'|'engage'|'cancel'} */
export function armHold(a) {
  if (!a.down) return 'cancel';
  return a.kind === 'platter' ? 'engage' : 'pending';
}
