// Compact rotary knob (44 x 44 px hit area) operated by vertical dragging: up = more.
// Pointer-captured per knob (multi-touch safe), pointercancel ends the drag, double-tap resets.

import { createTapTracker } from './tap.js';

const DRAG_PX = 110; // full travel
const SWEEP = 270; // degrees from min to max

/**
 * @param {object} o
 * @param {string} o.label  accessible name; its first word is the on-knob caption unless shortName is given
 * @param {string} [o.shortName]  on-knob caption
 * @param {number} o.value
 * @param {number} [o.defaultValue]  restored by a double-tap
 * @param {{at:number, width:number}} [o.detent]  dead zone: values within `width` of `at` read as exactly `at`
 *        (a centre-off knob such as the filter). The drag keeps its own unsnapped position, so slow turns
 *        still get out of the dead zone.
 * @param {(v:number)=>string} [o.valueText]  spoken value (aria-valuetext)
 * @param {(v:number)=>void} o.onInput
 */
export function createKnob({ label, shortName, value, defaultValue = value, detent = null, valueText, onInput }) {
  const el = document.createElement('div');
  el.className = 'knob';
  if (detent) el.classList.add('knob-centre');
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.innerHTML = '<span class="knob-dial"></span><span class="knob-name"></span>';
  el.querySelector('.knob-name').textContent = shortName || label.split(' ')[0];

  let v = value;
  let raw = value; // unsnapped position while dragging
  let activeId = null;
  let lastY = 0;
  const taps = createTapTracker();
  const snap = (x) => (detent && Math.abs(x - detent.at) <= detent.width + 1e-9 ? detent.at : x);

  function render() {
    el.style.setProperty('--angle', `${-SWEEP / 2 + v * SWEEP}deg`);
    el.dataset.killed = !detent && v < 0.02 ? 'true' : 'false';
    if (detent) el.dataset.centre = String(v === detent.at); // false = the filter is doing something
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
    if (valueText) el.setAttribute('aria-valuetext', valueText(v));
  }

  function set(next, emit) {
    next = Math.min(1, Math.max(0, next));
    raw = next;
    next = snap(next);
    if (next === v) return;
    v = next;
    render();
    if (emit) onInput(v);
  }

  el.addEventListener('pointerdown', (e) => {
    if (activeId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    taps.down(performance.now(), e.clientX, e.clientY);
    activeId = e.pointerId;
    lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activeId) return;
    taps.move(e.clientX, e.clientY);
    const dy = lastY - e.clientY;
    lastY = e.clientY;
    set(raw + dy / DRAG_PX, true);
  });
  // Reset needs two real taps (< 6 px, < 250 ms); turning the knob twice in a row never resets it.
  const end = (e, cancelled) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    el.classList.remove('active');
    if (cancelled) taps.cancel();
    else if (taps.up(performance.now(), e.clientX, e.clientY) === 'double') set(defaultValue, true);
  };
  el.addEventListener('pointerup', (e) => end(e, false));
  for (const t of ['pointercancel', 'lostpointercapture']) el.addEventListener(t, (e) => end(e, true));
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(raw + step, true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(raw - step, true);
    else if (e.key === 'Home') set(0, true);
    else if (e.key === 'End') set(1, true);
    else if (e.key === '0') set(defaultValue, true);
    else return;
    e.preventDefault();
  });

  render();
  return { el, get value() { return v; }, setValue: (n) => set(n, false) };
}
