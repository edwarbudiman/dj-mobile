// Custom fader (vertical or horizontal) driven by pointer events.
// Each fader captures its own pointer, so several can be moved at once with multiple fingers.
// pointercancel / lost capture always end the drag. Double-tap resets to the default value.
//
// Modes:
//   absolute (default): touching the track jumps the thumb to the finger.
//   relative: the thumb never jumps; drags move it by the finger's delta. With `fine`, moving the
//             finger sideways away from the fader slows the thumb (x0.25, then x0.05), like an
//             iOS scrubber, so tiny pitch corrections are possible.

import { createTapTracker } from './tap.js';

const FINE_NEAR_PX = 36; // sideways distance where fine mode starts
const FINE_FAR_PX = 90; // ... and ultra-fine mode

/**
 * @param {object} o
 * @param {string} o.label            accessible name (also the caption unless caption is false)
 * @param {'vertical'|'horizontal'} [o.orientation]
 * @param {number} [o.value]          initial 0..1
 * @param {number} [o.defaultValue]   value restored on double-tap
 * @param {number} [o.snap]           absolute mode: snap to defaultValue when within this distance
 * @param {boolean} [o.relative]
 * @param {boolean} [o.fine]          relative mode: sideways precision zones
 * @param {boolean} [o.caption]       render the label under the fader (default true)
 * @param {[string,string]} [o.endLabels] legends at the low/high ends of the track
 * @param {number|(()=>number)} [o.keyStep] keyboard step (fraction of travel)
 * @param {boolean} [o.badge]         show the active precision multiplier (x1, x1/4, x1/20) beside the thumb while dragging
 * @param {()=>void} [o.onTouch]      called on every pointerdown that starts a drag
 * @param {(v:number)=>void} o.onInput
 */
export function createFader({
  label, orientation = 'vertical', value = 0, defaultValue = value, snap = 0.02,
  relative = false, fine = false, caption = true, endLabels = null, keyStep = 0.02, badge = false, onTouch, onInput,
}) {
  const horizontal = orientation === 'horizontal';
  const THUMB = horizontal ? 40 : 28; // px, must match css

  const wrap = document.createElement('div');
  wrap.className = `fader-wrap ${horizontal ? 'fader-wrap-h' : ''}`;
  const el = document.createElement('div');
  el.className = `fader ${horizontal ? 'fader-h' : 'fader-v'}`;
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-orientation', orientation);
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.style.setProperty('--d', String(defaultValue));
  el.innerHTML = '<span class="fader-track"></span><span class="fader-tick"></span><span class="fader-thumb"></span>';
  if (endLabels) {
    for (const [i, text] of endLabels.entries()) {
      const s = document.createElement('span');
      s.className = `fader-end fader-end-${i ? 'hi' : 'lo'}`;
      s.textContent = text;
      el.appendChild(s);
    }
  }
  let badgeEl = null;
  if (badge) {
    badgeEl = document.createElement('span');
    badgeEl.className = 'fader-badge';
    badgeEl.setAttribute('aria-hidden', 'true');
    el.appendChild(badgeEl);
  }
  wrap.appendChild(el);
  let captionEl = null;
  if (caption) {
    captionEl = document.createElement('span');
    captionEl.className = 'fader-label';
    captionEl.textContent = label;
    wrap.appendChild(captionEl);
  }

  let v = value;
  let activeId = null;
  let grabOffset = 0;
  let lastPos = 0;
  const taps = createTapTracker();

  function render() {
    el.style.setProperty('--v', String(v));
    el.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }

  function set(next, emit) {
    next = Math.min(1, Math.max(0, next));
    if (next === v) return;
    v = next;
    render();
    if (emit) onInput(v);
  }

  // Distance of the pointer from the low end of the fader along its axis, in px.
  const axisPos = (e, rect) => (horizontal ? e.clientX - rect.left : rect.bottom - e.clientY);
  const travel = (rect) => (horizontal ? rect.width : rect.height) - THUMB;

  function precision(e, rect) {
    if (!fine) return { factor: 1, name: '' };
    const perp = horizontal ? Math.abs(e.clientY - (rect.top + rect.height / 2)) : Math.abs(e.clientX - (rect.left + rect.width / 2));
    if (perp > FINE_FAR_PX) return { factor: 0.05, name: 'ultra' };
    if (perp > FINE_NEAR_PX) return { factor: 0.25, name: 'fine' };
    return { factor: 1, name: '' };
  }

  function end(e, cancelled) {
    if (e.pointerId !== activeId) return;
    activeId = null;
    el.classList.remove('active');
    delete el.dataset.precision;
    // Double-tap reset needs two real TAPS (< 6 px of movement, < 250 ms); drag strokes never qualify.
    if (cancelled) taps.cancel();
    else if (taps.up(performance.now(), e.clientX, e.clientY) === 'double') set(defaultValue, true);
  }

  el.addEventListener('pointerdown', (e) => {
    if (activeId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    taps.down(performance.now(), e.clientX, e.clientY);
    onTouch?.();
    activeId = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    if (badgeEl) badgeEl.textContent = '×1';
    const rect = el.getBoundingClientRect();
    lastPos = axisPos(e, rect);
    if (relative) return; // never jump
    const len = travel(rect);
    const off = lastPos - (v * len + THUMB / 2);
    grabOffset = Math.abs(off) <= THUMB / 2 + 8 ? off : 0;
    if (len > 0) set((lastPos - grabOffset - THUMB / 2) / len, true);
  });

  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activeId) return;
    taps.move(e.clientX, e.clientY);
    const rect = el.getBoundingClientRect();
    const len = travel(rect);
    if (!(len > 0)) return;
    const pos = axisPos(e, rect);
    if (relative) {
      const p = precision(e, rect);
      if (p.name) el.dataset.precision = p.name;
      else delete el.dataset.precision;
      if (badgeEl) badgeEl.textContent = p.name === 'ultra' ? '×1/20' : p.name === 'fine' ? '×1/4' : '×1';
      set(v + ((pos - lastPos) / len) * p.factor, true);
      lastPos = pos;
      return;
    }
    let next = (pos - grabOffset - THUMB / 2) / len;
    if (snap && Math.abs(next - defaultValue) < snap) next = defaultValue;
    set(next, true);
  });

  el.addEventListener('pointerup', (e) => end(e, false));
  for (const type of ['pointercancel', 'lostpointercapture']) el.addEventListener(type, (e) => end(e, true));

  el.addEventListener('keydown', (e) => {
    const base = typeof keyStep === 'function' ? keyStep() : keyStep;
    const step = e.shiftKey ? base * 10 : base;
    const keys = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 5, PageDown: -step * 5 };
    if (e.key in keys) set(v + keys[e.key], true);
    else if (e.key === 'Home') set(0, true);
    else if (e.key === 'End') set(1, true);
    else if (e.key === '0') set(defaultValue, true);
    else return;
    e.preventDefault();
  });

  render();
  return {
    el: wrap,
    get value() { return v; },
    setValue: (next) => set(next, false),
    setLabel: (text) => {
      if (captionEl) captionEl.textContent = text;
    },
  };
}
