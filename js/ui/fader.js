// Custom fader (vertical or horizontal) driven by pointer events.
// Each fader captures its own pointer, so several can be moved at once with multiple fingers.
// pointercancel / lost capture always end the drag. Double-tap resets to the default value.

const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 24;

/**
 * @param {object} o
 * @param {string} o.label            text shown under the fader (also its accessible name)
 * @param {'vertical'|'horizontal'} [o.orientation]
 * @param {number} [o.value]          initial 0..1
 * @param {number} [o.defaultValue]   value restored on double-tap (also the detent)
 * @param {number} [o.snap]           snap to defaultValue when within this distance while dragging
 * @param {(v:number)=>void} o.onInput
 */
export function createFader({ label, orientation = 'vertical', value = 0, defaultValue = value, snap = 0.02, onInput }) {
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
  const caption = document.createElement('span');
  caption.className = 'fader-label';
  caption.textContent = label;
  wrap.append(el, caption);

  let v = value;
  let activeId = null;
  let grabOffset = 0;
  let lastDown = { t: 0, x: 0, y: 0 };

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
  function axisPos(e, rect) {
    return horizontal ? e.clientX - rect.left : rect.bottom - e.clientY;
  }

  function fromPointer(e) {
    const rect = el.getBoundingClientRect();
    const len = (horizontal ? rect.width : rect.height) - THUMB;
    if (len <= 0) return v;
    return (axisPos(e, rect) - grabOffset - THUMB / 2) / len;
  }

  function end(e) {
    if (e.pointerId !== activeId) return;
    activeId = null;
    el.classList.remove('active');
  }

  el.addEventListener('pointerdown', (e) => {
    if (activeId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    const now = performance.now();
    const isDouble =
      now - lastDown.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < DOUBLE_TAP_PX;
    lastDown = { t: now, x: e.clientX, y: e.clientY };
    if (isDouble) {
      lastDown.t = 0;
      set(defaultValue, true);
      return;
    }
    activeId = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    // Grabbing the thumb keeps its offset; touching the track jumps the thumb to the finger.
    const rect = el.getBoundingClientRect();
    const len = (horizontal ? rect.width : rect.height) - THUMB;
    const thumbCenter = v * len + THUMB / 2;
    const off = axisPos(e, rect) - thumbCenter;
    grabOffset = Math.abs(off) <= THUMB / 2 + 8 ? off : 0;
    set(fromPointer(e), true);
  });

  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activeId) return;
    let next = fromPointer(e);
    if (snap && Math.abs(next - defaultValue) < snap) next = defaultValue;
    set(next, true);
  });

  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(type, end);

  el.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 0.1 : 0.02;
    const keys = {
      ArrowUp: big, ArrowRight: big, ArrowDown: -big, ArrowLeft: -big, PageUp: 0.1, PageDown: -0.1,
    };
    if (e.key in keys) set(v + keys[e.key], true);
    else if (e.key === 'Home') set(0, true);
    else if (e.key === 'End') set(1, true);
    else if (e.key === '0') set(defaultValue, true);
    else return;
    e.preventDefault();
  });

  render();
  return { el: wrap, get value() { return v; }, setValue: (next) => set(next, false) };
}
