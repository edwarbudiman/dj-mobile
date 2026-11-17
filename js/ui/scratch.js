// Scratch input for one deck: a finger on the platter (angle about the centre -> track time) or on the
// zoomed waveform (horizontal pixels -> track time) grabs the record.
//
// Rules: one grabbing pointer per deck, on either surface (a second finger on the same or the other
// surface is ignored). The pointer is captured, so the grab survives leaving the element. Pointer up,
// pointercancel and lostpointercapture all release; main.js also releases on blur / visibility change.
// Nothing happens without a loaded track. Non-finite geometry never reaches the deck.
//
// Landscape: a touch grabs at once. Portrait (the stacked layout scrolls vertically, and these surfaces
// are touch-action: pan-y there): a touch only ARMS (see scratch-arm.js): it becomes a grab after a
// ~250 ms hold on the platter, or when the first movement is horizontal (waveform) / around the vinyl
// (platter). A vertical swipe is left to the page, and a hold alone never grabs the waveform. The armed
// pointer is captured at press time, and any pointerup / pointercancel / lostpointercapture (also on
// window) for it disarms, so a late hold timer can never grab a finger that has already left.

import { AngleTracker, angleToSeconds, pixelsToSeconds } from '../audio/scratch-math.js';
import { ARM_HOLD_MS, armHold, armMove, armStart, armUp } from './scratch-arm.js';

function uncapture(el, id) {
  try {
    if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
  } catch {
    /* already released */
  }
}

/**
 * @param {object} o
 * @param {()=>import('../audio/deck.js').Deck|null} o.getDeck
 * @param {HTMLElement} o.platterEl  the platter canvas
 * @param {HTMLElement} o.waveEl     the zoom waveform container
 * @param {()=>number|null} o.secondsPerPixel  zoom view scale
 * @returns {{release:(reason?:string)=>void, forget:()=>void, active:boolean}}
 */
export function createScratch({ getDeck, platterEl, waveEl, secondsPerPixel }) {
  let owner = null; // the grab: { kind, id, el, ... }
  let armed = null; // portrait: a touch waiting to become a grab { kind, id, el, geo, state, timer }
  const tracker = new AngleTracker();
  const portrait = () => typeof matchMedia === 'function' && matchMedia('(orientation: portrait)').matches;

  // The armed pointer is gone (or the touch was left to scroll): forget it and let go of the capture.
  function disarm() {
    if (!armed) return;
    const a = armed;
    armed = null;
    armUp(a.state);
    clearTimeout(a.timer);
    if (!owner || owner.id !== a.id) uncapture(a.el, a.id);
  }

  function end(reason) {
    disarm();
    if (!owner) return;
    const { el, id } = owner;
    owner = null;
    el.classList.remove('grabbing');
    uncapture(el, id);
    getDeck()?.scratchEnd(reason);
  }

  // The grab proper: stop the record, capture the pointer, anchor the geometry at (x, y).
  function engage(kind, el, id, x, y, geo) {
    const deck = getDeck();
    if (owner || !deck || !deck.loaded || !deck.scratchBegin()) return false;
    owner = { kind, id, el, ...geo };
    el.classList.add('grabbing');
    try {
      el.setPointerCapture(id);
    } catch {
      /* pointer already gone: the up/cancel handlers still end the grab */
    }
    if (kind === 'platter') {
      tracker.reset();
      tracker.update(x - geo.cx, y - geo.cy, geo.radius); // anchors (stays unanchored inside the label)
    } else {
      owner.x = x;
    }
    return true;
  }

  function press(e, kind, el, geo) {
    const deck = getDeck();
    if (owner || armed || !deck || !deck.loaded) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!portrait()) {
      e.preventDefault();
      engage(kind, el, e.pointerId, e.clientX, e.clientY, geo);
      return;
    }
    const a = { kind, el, id: e.pointerId, geo, state: armStart(kind, e.clientX, e.clientY, geo), timer: 0 };
    // Capture now: pointerup then reaches us wherever the finger or mouse is released, and capture does
    // not stop the browser from scrolling (touch-action: pan-y), which then cancels the pointer.
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
    a.timer = setTimeout(() => {
      if (armed !== a) return;
      const r = armHold(a.state);
      if (r === 'cancel') disarm();
      else if (r === 'engage') {
        armed = null; // held on the vinyl: it is a scratch, not a scroll
        engage(kind, el, a.id, a.state.x, a.state.y, geo);
      }
    }, ARM_HOLD_MS);
    armed = a;
  }

  // A moving armed touch decides: scratch-like movement engages, a vertical swipe is left to scroll.
  function armedMove(e) {
    const a = armed;
    const r = armMove(a.state, e.clientX, e.clientY);
    if (r === 'pending') return;
    if (r === 'cancel') {
      disarm();
      return;
    }
    clearTimeout(a.timer);
    armed = null;
    engage(a.kind, a.el, a.id, a.state.x0, a.state.y0, a.geo); // grab from the press point so no travel is lost
    if (owner && owner.kind === a.kind) moveFrom(e);
  }

  // The armed pointer ending anywhere (not just over our element) disarms.
  for (const t of ['pointerup', 'pointercancel']) {
    window.addEventListener(t, (e) => {
      if (armed && e.pointerId === armed.id) disarm();
    });
  }

  // ---- platter -------------------------------------------------------------------------
  platterEl.addEventListener('pointerdown', (e) => {
    if (owner || armed) return;
    const r = platterEl.getBoundingClientRect();
    const radius = Math.min(r.width, r.height) / 2;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    if (!(radius > 0) || !Number.isFinite(dx + dy) || Math.hypot(dx, dy) > radius) return; // canvas corners are not vinyl
    press(e, 'platter', platterEl, { cx, cy, radius });
  });

  // ---- zoom waveform -------------------------------------------------------------------
  waveEl.addEventListener('pointerdown', (e) => {
    if (owner || armed || !(secondsPerPixel() > 0)) return;
    press(e, 'wave', waveEl, {});
  });

  function moveFrom(e) {
    if (owner.kind === 'platter') {
      const rad = tracker.update(e.clientX - owner.cx, e.clientY - owner.cy, owner.radius);
      if (rad !== 0) getDeck()?.scratchBy(angleToSeconds(rad), e.timeStamp);
    } else {
      const dx = e.clientX - owner.x;
      owner.x = e.clientX;
      // read the scale per event: the view eases in while grabbed, and the finger must stay on the waveform
      const s = pixelsToSeconds(dx, secondsPerPixel());
      if (s !== 0) getDeck()?.scratchBy(s, e.timeStamp);
    }
  }

  for (const el of [platterEl, waveEl]) {
    el.addEventListener('pointermove', (e) => {
      if (owner && owner.el === el && e.pointerId === owner.id) moveFrom(e);
      else if (armed && armed.el === el && e.pointerId === armed.id) armedMove(e);
    });
    el.addEventListener('pointerup', (e) => {
      if (armed && armed.el === el && e.pointerId === armed.id) disarm(); // a tap: nothing to do
      if (owner && owner.el === el && e.pointerId === owner.id) end('release');
    });
    for (const t of ['pointercancel', 'lostpointercapture']) {
      el.addEventListener(t, (e) => {
        if (armed && armed.el === el && e.pointerId === armed.id) disarm();
        if (owner && owner.el === el && e.pointerId === owner.id) end(t);
      });
    }
    // Once a grab is engaged the page must not scroll under the finger (portrait).
    el.addEventListener(
      'touchmove',
      (e) => {
        if (owner && owner.el === el && e.cancelable) e.preventDefault();
      },
      { passive: false },
    );
  }

  return {
    /** Drop any grab (blur, hidden tab, audio blocked). */
    release(reason = 'release') {
      end(reason);
      getDeck()?.scratchEnd(reason); // also clears a grab whose pointer bookkeeping was lost
    },
    /** The Deck ended the grab itself (track replaced): forget the pointer. */
    forget() {
      disarm();
      if (!owner) return;
      const { el, id } = owner;
      owner = null;
      el.classList.remove('grabbing');
      try {
        if (el.hasPointerCapture?.(id)) el.releasePointerCapture(id);
      } catch {
        /* ignore */
      }
    },
    get active() {
      return owner !== null;
    },
  };
}
