// Compact rotary knob (44 x 44 px hit area) operated by vertical dragging: up = more.
// Pointer-captured per knob (multi-touch safe), pointercancel ends the drag, double-tap resets.

import { createTapTracker } from './tap.js';

const DRAG_PX = 110; // full travel
const SWEEP = 270; // degrees from min to max

/**
 * @param {{label:string, value:number, defaultValue?:number, onInput:(v:number)=>void}} o
 */
export function createKnob({ label, value, defaultValue = value, onInput }) {
  const el = document.createElement('div');
  el.className = 'knob';
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.innerHTML = '<span class="knob-dial"></span><span class="knob-name"></span>';
  el.querySelector('.knob-name').textContent = label.split(' ')[0];

  let v = value;
  let activeId = null;
  let lastY = 0;
  const taps = createTapTracker();

  function render() {
    el.style.setProperty('--angle', `${-SWEEP / 2 + v * SWEEP}deg`);
    el.dataset.killed = v < 0.02 ? 'true' : 'false';
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }

  function set(next, emit) {
    next = Math.min(1, Math.max(0, next));
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
    set(v + dy / DRAG_PX, true);
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
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(v + step, true);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(v - step, true);
    else if (e.key === 'Home') set(0, true);
    else if (e.key === 'End') set(1, true);
    else if (e.key === '0') set(defaultValue, true);
    else return;
    e.preventDefault();
  });

  render();
  return { el, get value() { return v; }, setValue: (n) => set(n, false) };
}
