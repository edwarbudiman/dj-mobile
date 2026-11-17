// Pad grid for one deck: replaces the platter while the Pads button is lit (see deck-view.js).
//
// Two pages, each a 2 x 3 grid of >= 44 px cells (the platter's own footprint: 128 x 136 px at 667 x 300,
// so 3 rows of 44 px with 2 px gaps). The bottom-right cell is always the page switch:
//   hot cues : [1][2] / [3][4] / [Clear][Loops]      Empty pad: set a cue here. Set pad: jump to it.
//                                                     Clear arms a one-shot delete: the next set cue you tap goes.
//   loops    : [1][2] / [4][8] / [Exit][Hot cues]    Auto-loop of that many beats from the beat at or before the
//                                                     playhead; tap the lit size again, or Exit, to leave the loop.
// Pads act on pointerdown (minimum latency, like Play); click with detail 0 covers the keyboard.

import { HOT_CUE_COUNT } from '../audio/cue-math.js';
import { LOOP_BEATS, loopLabel, loopRefusal } from '../audio/loop-math.js';
import { formatDuration } from './format.js';

function pad(cls, html, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `pad ${cls}`;
  b.innerHTML = html;
  if (label) b.setAttribute('aria-label', label);
  return b;
}

/** Press on pointerdown for latency; keyboard activation arrives as a click with detail 0. */
function onPress(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    fn();
  });
  el.addEventListener('click', (e) => {
    if (e.detail === 0) fn();
  });
}

/**
 * @param {HTMLElement} root  the (initially hidden) .pads element
 * @param {{id:string, getDeck:()=>import('../audio/deck.js').Deck|null, notify:(msg:string, o?:object)=>void,
 *          onPage?:(page:'cues'|'loops')=>void}} o  onPage: the in-grid page switch was used
 */
export function createPads(root, { id, getDeck, notify, onPage }) {
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', `Deck ${id} pads`);

  const cuesPage = document.createElement('div');
  cuesPage.className = 'pads-page';
  cuesPage.dataset.page = 'cues';
  const loopsPage = document.createElement('div');
  loopsPage.className = 'pads-page';
  loopsPage.dataset.page = 'loops';
  root.append(cuesPage, loopsPage);

  let page = null;
  let clearArmed = false;

  // ---- hot cue pads ----
  const cuePads = [];
  for (let i = 0; i < HOT_CUE_COUNT; i++) {
    const b = pad(`pad-cue pad-cue-${i + 1}`, `<span class="pad-num">${i + 1}</span><span class="pad-sub"></span>`, `Hot cue ${i + 1}`);
    onPress(b, () => {
      const deck = getDeck();
      if (!deck || !deck.loaded) return;
      const isSet = deck.hotCues[i] !== null;
      if (clearArmed) {
        if (isSet) {
          deck.clearHotCue(i);
          setClearArmed(false);
        }
        return;
      }
      if (isSet) deck.jumpHotCue(i);
      else deck.setHotCue(i);
      b.classList.add('hit');
      setTimeout(() => b.classList.remove('hit'), 110);
    });
    cuePads.push(b);
    cuesPage.appendChild(b);
  }
  const clearBtn = pad('pad-clear', 'Clear', 'Clear a hot cue: tap, then tap the cue to remove');
  clearBtn.setAttribute('aria-pressed', 'false');
  onPress(clearBtn, () => {
    const deck = getDeck();
    if (!deck || !deck.loaded) return;
    if (!clearArmed && deck.hotCues.every((c) => c === null)) {
      notify('No hot cues to clear on this deck.', { ms: 2500 });
      return;
    }
    setClearArmed(!clearArmed);
  });
  cuesPage.appendChild(clearBtn);

  // ---- loop pads ----
  const loopPads = LOOP_BEATS.map((beats) => {
    const b = pad('pad-loop', `<span class="pad-num">${loopLabel(beats)}</span>`, `Loop ${beats === 1 ? '1 beat' : `${beats} beats`}`);
    b.dataset.beats = String(beats);
    b.setAttribute('aria-pressed', 'false');
    onPress(b, () => {
      const deck = getDeck();
      if (!deck || !deck.loaded) return;
      const res = deck.autoLoop(beats);
      if (!res.ok) notify(loopRefusal(res.reason), { kind: 'warn', ms: 3500 });
    });
    loopsPage.appendChild(b);
    return b;
  });
  const exitBtn = pad('pad-exit', 'Exit', 'Exit loop');
  onPress(exitBtn, () => getDeck()?.exitLoop());
  loopsPage.appendChild(exitBtn);

  // ---- page switch: the bottom-right cell of each page ----
  function pageSwitch(to, text) {
    const b = pad('pad-switch', text, to === 'loops' ? 'Show loop pads' : 'Show hot cue pads');
    onPress(b, () => {
      api.setPage(to);
      onPage?.(to);
    });
    return b;
  }
  cuesPage.appendChild(pageSwitch('loops', 'Loops'));
  loopsPage.appendChild(pageSwitch('cues', 'Hot cues'));

  function setClearArmed(on) {
    clearArmed = on;
    clearBtn.setAttribute('aria-pressed', String(on));
    root.classList.toggle('clearing', on);
    refresh();
  }

  function refresh() {
    const deck = getDeck();
    const loaded = !!deck && deck.loaded;
    const cues = loaded ? deck.hotCues : [];
    for (let i = 0; i < HOT_CUE_COUNT; i++) {
      const b = cuePads[i];
      const t = cues[i] ?? null;
      b.disabled = !loaded;
      b.classList.toggle('set', t !== null);
      b.classList.toggle('del-target', clearArmed && t !== null);
      b.querySelector('.pad-sub').textContent = clearArmed && t !== null ? 'Clear' : t !== null ? formatDuration(t) : '';
    }
    clearBtn.disabled = !loaded;
    const hasGrid = loaded && !!deck.grid;
    const loop = loaded ? deck.loop : null;
    loopPads.forEach((b) => {
      const on = !!loop && loop.beats === Number(b.dataset.beats);
      b.disabled = !loaded;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-disabled', String(loaded && !hasGrid)); // tappable: explains why it cannot loop
    });
    exitBtn.disabled = !loaded;
    exitBtn.setAttribute('aria-disabled', String(!loop));
  }

  const api = {
    get page() {
      return page;
    },
    /** Show a page ('cues' | 'loops') or null to hide the pads. Leaving a page disarms Clear. */
    setPage(next) {
      if (next !== page) setClearArmed(false);
      page = next;
      root.hidden = next === null;
      cuesPage.hidden = next !== 'cues';
      loopsPage.hidden = next !== 'loops';
      refresh();
    },
    /** Drop the armed Clear mode (a new track was loaded, the pads were closed). */
    disarm() {
      if (clearArmed) setClearArmed(false);
    },
    refresh,
  };
  return api;
}
