// Deck panel view. Landscape layout (deck A; deck B is mirrored by CSS):
//
//   readout   [A] 128.0 BPM                         -3:42.1      <- 20px numerals
//   zoom      full-bleed scrolling waveform (title, elapsed, beat dots overlaid)
//   overview  thin whole-track strip (tap / drag to seek)
//   lower     [ pitch strip | platter or pads         | tools ]
//             [ (outer edge) | Play  Cue (outer corner) |       ]
//   Tools (top to bottom): Grid, Tap, Sync, Pads. Pads toggles the pad grid, which takes the platter's
//   place (transport and pitch strip stay put); a switch inside the grid picks hot cues or loops.
//
// The Deck (audio side) is attached after the engine starts; until then the controls are disabled.

import { LOW_CONFIDENCE } from '../audio/bpm-core.js';
import { beatPosition, faderToPitch, pitchToFader, retempo, shiftGrid, tapTempo } from '../audio/sync-math.js';
import { createFader } from './fader.js';
import { formatRemaining, formatTime } from './format.js';
import { createPads } from './pads.js';
import { Platter } from './platter.js';
import { createScratch } from './scratch.js';
import { Overview, ZoomWave } from './waveform.js';

const TEMPLATE = `
  <div class="readout">
    <span class="deck-badge" data-role="badge"></span>
    <span class="bpm"><span class="bpm-num" data-role="bpm-num">--.-</span><span class="bpm-unit">BPM</span><span class="bpm-flag" data-role="bpm-flag"></span></span>
    <span class="remaining" data-role="remaining">-0:00.0</span>
  </div>
  <div class="wave wave-zoom" data-slot="zoom-wave">
    <canvas data-role="zoom"></canvas>
    <span class="wave-title" data-role="title"></span>
    <span class="wave-elapsed" data-role="elapsed"></span>
    <span class="beat-dots" data-role="dots" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <button type="button" class="wave-empty" data-role="load">Load a track</button>
  </div>
  <div class="wave wave-overview" data-slot="overview-wave" data-role="over-hit"><canvas data-role="overview"></canvas></div>
  <div class="deck-lower">
    <div class="pitch-strip">
      <button type="button" class="btn btn-bend" data-role="bend-down" aria-label="Pitch bend slower (hold)" disabled>−</button>
      <button type="button" class="btn btn-bend" data-role="bend-up" aria-label="Pitch bend faster (hold)" disabled>+</button>
      <div class="pitch-readout" data-role="pitch-readout" role="spinbutton" tabindex="0" aria-label="Pitch value; swipe up or down, or use the arrow keys, to step by 0.02%" title="Swipe up or down to step the pitch by 0.02%">
        <span class="pitch-step pitch-step-up" aria-hidden="true">▴</span>
        <span class="pitch-value" data-role="pitch-value">0.00%</span>
        <span class="pitch-step pitch-step-down" aria-hidden="true">▾</span>
      </div>
      <div class="pitch-slot" data-role="pitch-slot"></div>
    </div>
    <div class="platter-slot" data-slot="platter"><canvas data-role="platter"></canvas></div>
    <div class="pads" data-role="pads" hidden></div>
    <div class="transport">
      <button type="button" class="btn btn-play" data-role="play" disabled>Play</button>
      <button type="button" class="btn btn-cue" data-role="cue" disabled>Cue</button>
    </div>
    <div class="tools">
      <button type="button" class="btn btn-quiet" data-role="grid" aria-haspopup="true" aria-expanded="false" disabled>Grid</button>
      <button type="button" class="btn btn-quiet" data-role="tap" disabled>Tap</button>
      <button type="button" class="btn btn-quiet btn-sync" data-role="sync" aria-disabled="true">Sync</button>
      <button type="button" class="btn btn-quiet btn-pads" data-role="pads-btn" aria-pressed="false" aria-label="Pads: hot cues and loops" disabled>Pads</button>
    </div>
  </div>
  <div class="popover" data-role="panel" role="dialog" aria-label="Beat grid" hidden>
    <div class="pop-live" aria-hidden="true"><span data-role="pop-bpm">--.-</span><span data-role="pop-rem">-0:00</span></div>
    <button type="button" class="btn" data-act="x2">×2</button>
    <button type="button" class="btn" data-act="half">÷2</button>
    <button type="button" class="btn" data-act="bpm-down">−0.1</button>
    <button type="button" class="btn" data-act="bpm-up">+0.1</button>
    <button type="button" class="btn" data-act="shift-left" aria-label="Shift grid 10 ms earlier">◂10ms</button>
    <button type="button" class="btn" data-act="shift-right" aria-label="Shift grid 10 ms later">10ms▸</button>
    <button type="button" class="btn" data-act="range" aria-label="Pitch range for this deck">±8%</button>
  </div>`;

/** Press-and-hold tracked on one pointer; other pointers are ignored. */
function holdPointer(el, onStart, onEnd) {
  let id = null;
  el.addEventListener('pointerdown', (e) => {
    if (id !== null || el.disabled) return;
    e.preventDefault();
    id = e.pointerId;
    el.setPointerCapture(e.pointerId);
    el.classList.add('held');
    onStart();
  });
  const up = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    el.classList.remove('held');
    onEnd();
  };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up);
}

const pct = (p) => `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}%`;

/**
 * @param {HTMLElement} root  the .deck element
 * @param {{id:string, onLoadClick:()=>void, onSync:()=>void, notify?:(msg:string, o?:object)=>void}} o
 */
export function createDeckView(root, { id, onLoadClick, onSync, notify = () => {} }) {
  root.classList.add(`deck-${id.toLowerCase()}`);
  root.dataset.deck = id;
  root.innerHTML = TEMPLATE;
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  $('badge').textContent = id;
  const titleEl = $('title');
  const loadBtn = $('load');
  const cueBtn = $('cue');
  const playBtn = $('play');
  const tapBtn = $('tap');
  const syncBtn = $('sync');
  const padsBtn = $('pads-btn');
  const gridBtn = $('grid');
  const bendUp = $('bend-up');
  const bendDown = $('bend-down');
  const panel = $('panel');
  const bpmNum = $('bpm-num');
  const bpmFlag = $('bpm-flag');
  const popBpm = $('pop-bpm');
  const popRem = $('pop-rem');
  const pitchValue = $('pitch-value');
  const pitchReadout = $('pitch-readout');
  const rangeBtn = panel.querySelector('[data-act="range"]');
  const dots = [...$('dots').children];
  const elapsedEl = $('elapsed');
  const remainingEl = $('remaining');
  const zoomSlot = root.querySelector('.wave-zoom');
  const overSlot = $('over-hit');

  let deck = null;
  let shown = { e: '', r: '', rc: '', dot: -2, pos: NaN };
  let taps = [];
  let redraw = true;

  const overview = new Overview($('overview'), {
    hit: overSlot,
    onSeek: (f) => {
      if (deck && deck.loaded && Number.isFinite(f)) deck.seek(f * deck.duration);
    },
  });
  const zoom = new ZoomWave($('zoom'));
  const platter = new Platter($('platter'), { letter: id });
  // Finger on the platter or the zoom waveform grabs the record; the overview strip keeps seeking.
  const scratch = createScratch({
    getDeck: () => deck,
    platterEl: platter.element,
    waveEl: zoomSlot,
    secondsPerPixel: () => zoom.secondsPerPixel,
  });

  // Pads: the pad grid takes the platter's place. The tool button only toggles it (lit while open; its label
  // is always "Pads", never "Cue", which is the transport button). The page (hot cues / loops) is switched
  // by the bottom-right cell inside the grid; the last page used comes back when the grid is reopened.
  let lastPadPage = 'cues';
  const pads = createPads($('pads'), {
    id,
    getDeck: () => deck,
    notify,
    onPage: (page) => {
      lastPadPage = page;
      root.dataset.pads = page;
    },
  });
  function setPadsPage(page) {
    pads.setPage(page);
    root.dataset.pads = page || '';
    padsBtn.classList.toggle('on', page !== null);
    padsBtn.setAttribute('aria-pressed', String(page !== null));
  }
  padsBtn.addEventListener('click', () => {
    if (pads.page) setPadsPage(null);
    else setPadsPage(lastPadPage);
  });

  loadBtn.addEventListener('click', onLoadClick);

  // PLAY: act on pointerdown for minimum latency; `click` with detail 0 covers keyboard activation.
  playBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    deck?.togglePlay();
  });
  playBtn.addEventListener('click', (e) => {
    if (e.detail === 0) deck?.togglePlay();
  });

  // CUE: hold-to-preview, tracked on the pointer that started the hold.
  holdPointer(cueBtn, () => deck?.cuePress(), () => deck?.cueRelease());
  let cueKey = false;
  cueBtn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat && !cueKey) {
      e.preventDefault();
      cueKey = true;
      deck?.cuePress();
    }
  });
  const cueKeyUp = () => {
    if (!cueKey) return;
    cueKey = false;
    deck?.cueRelease();
  };
  cueBtn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') cueKeyUp();
  });
  cueBtn.addEventListener('blur', cueKeyUp);

  // Pitch bend: bend = (held "+" buttons) - (held "-" buttons), so holding both and releasing one
  // leaves the other in effect.
  const held = { up: 0, down: 0 };
  const applyBend = () => deck?.setBend(Math.sign(held.up - held.down));
  holdPointer(bendUp, () => { held.up = 1; applyBend(); }, () => { held.up = 0; applyBend(); });
  holdPointer(bendDown, () => { held.down = 1; applyBend(); }, () => { held.down = 0; applyBend(); });

  // Pitch fader: down = faster (hardware convention). Relative, no centre snap, with sideways fine
  // mode; a badge beside the thumb shows the active multiplier while dragging, and a one-line hint
  // appears the first few times it is touched.
  const HINT_KEY = 'dj-mobile.pitchHint';
  const HINT_TIMES = 3;
  function pitchHint() {
    try {
      const n = Number(localStorage.getItem(HINT_KEY)) || 0;
      if (n >= HINT_TIMES) return;
      localStorage.setItem(HINT_KEY, String(n + 1));
      notify('Pitch: slide your finger sideways while dragging for fine control.', { ms: 3500 });
    } catch {
      /* storage unavailable: no hint */
    }
  }
  const pitchFader = createFader({
    label: `Pitch ${id}`,
    value: 0.5,
    defaultValue: 0.5,
    snap: 0,
    relative: true,
    fine: true,
    caption: false,
    badge: true,
    onTouch: pitchHint,
    keyStep: () => 0.02 / (2 * (deck ? deck.pitchRange : 8)), // 0.02 % per key press, x10 with Shift
    onInput: (v) => deck?.setPitch(faderToPitch(v, deck.pitchRange)),
  });
  pitchFader.el.setAttribute('title', 'Pitch. Drag; slide your finger sideways for fine control. Double-tap to reset.');
  $('pitch-slot').appendChild(pitchFader.el);

  {
    // The readout is a 44 x 44 px display that is also a vertical jog: swipe up or down on it and it
    // steps by 0.02 % per 10 px (up = slower, like the fader). There are no halves to hit, so a tap
    // can never step the wrong way; a plain tap does nothing. Arrow keys step too.
    const STEP = 0.02;
    const PX_PER_STEP = 10;
    let id2 = null;
    let lastY = 0;
    let acc = 0;
    const step = (dir) => {
      if (!deck || !deck.loaded) return;
      deck.setPitch(Math.round((deck.pitch + dir * STEP) * 100) / 100);
    };
    pitchReadout.addEventListener('pointerdown', (e) => {
      if (id2 !== null) return;
      e.preventDefault();
      id2 = e.pointerId;
      lastY = e.clientY;
      acc = 0;
      pitchReadout.setPointerCapture(e.pointerId);
      pitchReadout.classList.add('active');
    });
    pitchReadout.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id2) return;
      acc += e.clientY - lastY; // down = positive = faster
      lastY = e.clientY;
      const steps = Math.trunc(acc / PX_PER_STEP);
      if (steps) {
        acc -= steps * PX_PER_STEP;
        step(Math.sign(steps));
        for (let i = 1; i < Math.abs(steps); i++) step(Math.sign(steps));
      }
    });
    const release = (e) => {
      if (e.pointerId !== id2) return;
      id2 = null;
      pitchReadout.classList.remove('active');
    };
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) pitchReadout.addEventListener(t, release);
    pitchReadout.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') step(-1);
      else if (e.key === 'ArrowDown') step(1);
      else return;
      e.preventDefault();
    });
  }

  // TAP tempo.
  function doTap() {
    if (!deck || !deck.loaded) return;
    const now = performance.now() / 1000;
    if (taps.length && now - taps[taps.length - 1].t > 2) taps = [];
    taps.push({ t: now, pos: deck.heardPosition });
    if (taps.length > 8) taps.shift();
    tapBtn.classList.add('flash');
    setTimeout(() => tapBtn.classList.remove('flash'), 90);
    const res = tapTempo(taps, deck.playing);
    if (res) deck.setGrid({ bpm: res.bpm, offset: res.offset, confidence: 1, source: 'tap' });
    else if (deck.grid) {
      // First tap: keep the tempo, snap the grid phase to the tap.
      const p = 60 / deck.grid.bpm;
      deck.setGrid({ ...deck.grid, offset: ((taps[0].pos % p) + p) % p, confidence: 1, source: 'tap' });
    }
  }
  tapBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    doTap();
  });
  tapBtn.addEventListener('click', (e) => {
    if (e.detail === 0) doTap();
  });

  syncBtn.addEventListener('click', () => onSync());

  // Grid popover: anchored over the waveform area (never over the platter or transport) and
  // dismissed by tapping anywhere outside it.
  const outside = (e) => {
    if (!panel.contains(e.target) && !gridBtn.contains(e.target)) setPanel(false);
  };
  function setPanel(open) {
    panel.hidden = !open;
    gridBtn.setAttribute('aria-expanded', String(open));
    gridBtn.classList.toggle('on', open);
    document.removeEventListener('pointerdown', outside, true);
    if (open) document.addEventListener('pointerdown', outside, true);
  }
  gridBtn.addEventListener('click', () => setPanel(panel.hidden));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setPanel(false);
  });
  panel.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'range' && deck) {
      const next = deck.pitchRange === 8 ? 16 : 8;
      if (!deck.setPitchRange(next)) {
        notify(`Deck ${id} is at ${pct(deck.pitch)}. Bring the pitch inside ±${next}% before narrowing the range.`, { kind: 'warn', ms: 5000 });
      }
      return;
    }
    const g = deck?.grid;
    if (!act || !g) return;
    const anchor = deck.heardPosition;
    let next = null;
    if (act === 'x2') next = retempo(g, g.bpm * 2, anchor);
    else if (act === 'half') next = retempo(g, g.bpm / 2, anchor);
    else if (act === 'bpm-up') next = retempo(g, g.bpm + 0.1, anchor);
    else if (act === 'bpm-down') next = retempo(g, g.bpm - 0.1, anchor);
    else if (act === 'shift-left') next = shiftGrid(g, -0.01);
    else if (act === 'shift-right') next = shiftGrid(g, 0.01);
    if (next) deck.setGrid({ ...next, confidence: 1, source: 'manual' });
  });

  function syncEnabled() {
    const on = !!deck && deck.loaded;
    cueBtn.disabled = playBtn.disabled = tapBtn.disabled = gridBtn.disabled = bendUp.disabled = bendDown.disabled = padsBtn.disabled = !on;
    pads.refresh();
    for (const b of panel.querySelectorAll('[data-act]')) b.disabled = b.dataset.act === 'range' ? !on : !(on && deck.grid);
    zoomSlot.classList.toggle('has-track', on);
    overSlot.classList.toggle('has-track', on);
    loadBtn.hidden = on || (deck && deck.loading);
  }

  function syncPlay() {
    const playing = !!deck && deck.playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.classList.toggle('on', playing);
    playBtn.setAttribute('aria-pressed', String(playing));
    root.classList.toggle('playing', playing);
  }

  function syncTitle() {
    if (!deck) return;
    root.classList.toggle('loading', deck.loading);
    titleEl.textContent = deck.loading ? deck.loadingLabel : deck.track ? deck.track.name : '';
    titleEl.title = deck.track ? deck.track.name : '';
    loadBtn.hidden = deck.loaded || deck.loading;
  }

  function renderPitch() {
    if (!deck) return;
    pitchFader.setValue(pitchToFader(deck.pitch, deck.pitchRange));
    pitchValue.textContent = pct(deck.pitch);
    rangeBtn.textContent = `±${deck.pitchRange}%`;
  }

  function renderBpm() {
    let text = '--.-';
    let flag = '';
    let title = 'Open Grid to adjust the beat grid';
    let state = 'unknown';
    if (deck && deck.loaded) {
      if (deck.analyzing && !deck.grid) {
        text = '…';
        flag = 'analysing';
      } else if (!deck.grid) {
        flag = 'tap it';
        title = 'BPM unknown: tap the beat with Tap';
      } else {
        text = deck.effectiveBpm.toFixed(1);
        state = 'ok';
        if (deck.grid.confidence < LOW_CONFIDENCE) {
          flag = '?';
          state = 'low';
          title = 'Low confidence: check the grid, or correct it with Tap';
        }
      }
    }
    if (deck && deck.pitchRange === 16) flag = flag ? `${flag} ±16%` : '±16%'; // wide range is shown on the deck
    bpmNum.textContent = text;
    popBpm.textContent = text;
    bpmFlag.textContent = flag;
    root.querySelector('.bpm').dataset.state = state;
    root.querySelector('.bpm').title = title;
    shown.dot = -2;
  }

  return {
    id,
    root,
    overview,
    zoom,
    platter,
    /** Bind the audio-side Deck. */
    attach(d) {
      deck = d;
      d.addEventListener('loading', () => {
        loadBtn.disabled = d.loading;
        syncTitle();
      });
      d.addEventListener('track', () => {
        pads.disarm(); // an armed Clear must never delete a cue of the NEW track
        syncTitle();
        syncEnabled();
        taps = [];
        setPanel(false);
        overview.setPeaks(null);
        zoom.setPeaks(null);
        shown = { e: '', r: '', rc: '', dot: -2, pos: NaN };
        renderPitch();
        renderBpm();
        redraw = true;
      });
      d.addEventListener('grab', (e) => {
        root.classList.toggle('grabbed', e.detail.grabbed);
        if (!e.detail.grabbed) scratch.forget(); // e.g. a new track replaced the one in hand
        redraw = true;
      });
      d.addEventListener('playstate', syncPlay);
      d.addEventListener('cue', () => {
        redraw = true;
      });
      d.addEventListener('hotcues', () => {
        pads.refresh();
        redraw = true;
      });
      d.addEventListener('loop', () => {
        pads.refresh();
        redraw = true;
      });
      d.addEventListener('grid', () => {
        pads.refresh();
        renderBpm();
        syncEnabled();
        redraw = true;
      });
      d.addEventListener('pitch', () => {
        renderPitch();
        renderBpm();
      });
      d.addEventListener('error', syncTitle);
      syncTitle();
      syncEnabled();
      syncPlay();
      renderPitch();
      renderBpm();
    },
    /** Waveform data for the current track (null clears). */
    setPeaks(peaks) {
      overview.setPeaks(peaks);
      zoom.setPeaks(peaks);
      redraw = true;
    },
    refresh() {
      renderBpm();
      syncEnabled();
    },
    /** Let go of the record (window blur, hidden tab, audio blocked). */
    releaseGrab(reason) {
      scratch.release(reason);
    },
    setSyncAvailable(ok) {
      syncBtn.setAttribute('aria-disabled', String(!ok));
    },
    /** Per-frame update: text only when it changes, canvases only when needed. */
    tick() {
      if (!deck || !deck.loaded) {
        platter.draw(0, false); // the disc is visible before a track is loaded
        return;
      }
      const grabbed = deck.grabbed;
      const pos = deck.displayPosition; // the finger's position while grabbed, so the marker never trails it
      const left = deck.duration - pos;
      const e = formatTime(pos);
      const r = formatRemaining(left);
      if (e !== shown.e) elapsedEl.textContent = shown.e = e;
      if (r !== shown.r) {
        remainingEl.textContent = shown.r = r;
        popRem.textContent = r.slice(0, -2); // whole seconds in the popover, which hides the readout row
      }
      const rc = left <= 10 ? 'crit' : left <= 30 ? 'warn' : '';
      if (rc !== shown.rc) {
        shown.rc = rc;
        remainingEl.dataset.level = rc;
      }

      const grid = deck.grid;
      if (grid) {
        const dot = beatPosition(pos, grid).bar;
        if (dot !== shown.dot) {
          shown.dot = dot;
          dots.forEach((d, i) => d.classList.toggle('on', i === dot));
        }
      } else if (shown.dot !== -1) {
        shown.dot = -1;
        dots.forEach((d) => d.classList.remove('on'));
      }

      zoom.setGrabbed(grabbed);
      const dirty = overview.takeDirty() | zoom.takeDirty() | zoom.animating | redraw;
      if (dirty || deck.moving || pos !== shown.pos) {
        shown.pos = pos;
        redraw = false;
        const state = { pos, duration: deck.duration, cue: deck.cue, grid, grabbed, hotCues: deck.hotCues, loop: deck.loop };
        overview.draw(state);
        zoom.draw(state);
      }
      platter.draw(pos, deck.playing, grabbed);
    },
  };
}
