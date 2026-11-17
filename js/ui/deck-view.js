// Deck panel view: title, load button, time readouts, CUE and PLAY, and the reserved slots
// for the M2 waveforms and the M3 platter. The Deck (audio side) is attached after the
// engine starts; until then the transport is disabled.

import { formatRemaining, formatTime } from './format.js';

const TEMPLATE = `
  <header class="deck-head">
    <span class="deck-badge"></span>
    <div class="deck-title" data-role="title">No track loaded</div>
    <button type="button" class="btn btn-load" data-role="load">Load</button>
  </header>
  <div class="slot slot-zoom" data-slot="zoom-wave"><span class="slot-label">Zoomed waveform</span></div>
  <div class="slot slot-overview" data-slot="overview-wave"><span class="slot-label">Overview</span></div>
  <div class="deck-lower">
    <div class="slot slot-platter" data-slot="platter"><div class="platter-ph"><span class="slot-label">Platter</span></div></div>
    <div class="deck-ctrl">
      <div class="times">
        <span class="t-elapsed" data-role="elapsed">0:00.0</span>
        <span class="t-remaining" data-role="remaining">-0:00.0</span>
      </div>
      <button type="button" class="btn btn-cue" data-role="cue" disabled>CUE</button>
      <button type="button" class="btn btn-play" data-role="play" disabled>PLAY</button>
    </div>
  </div>`;

/**
 * @param {HTMLElement} root  the .deck element
 * @param {{id:string, onLoadClick:()=>void}} o
 */
export function createDeckView(root, { id, onLoadClick }) {
  root.classList.add(`deck-${id.toLowerCase()}`);
  root.dataset.deck = id;
  root.innerHTML = TEMPLATE;
  root.querySelector('.deck-badge').textContent = id;
  const $ = (r) => root.querySelector(`[data-role="${r}"]`);
  const titleEl = $('title');
  const loadBtn = $('load');
  const cueBtn = $('cue');
  const playBtn = $('play');
  const elapsedEl = $('elapsed');
  const remainingEl = $('remaining');

  let deck = null;
  let shown = { e: '', r: '' };

  loadBtn.addEventListener('click', onLoadClick);

  // PLAY: act on pointerdown for minimum latency; `click` with detail 0 covers keyboard activation.
  playBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    deck?.togglePlay();
  });
  playBtn.addEventListener('click', (e) => {
    if (e.detail === 0) deck?.togglePlay();
  });

  // CUE: press and release are distinct (hold-to-preview), so track the pointer until it ends.
  let cueDown = false;
  const cueUp = () => {
    if (!cueDown) return;
    cueDown = false;
    cueBtn.classList.remove('held');
    deck?.cueRelease();
  };
  cueBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (cueDown) return;
    cueDown = true;
    cueBtn.classList.add('held');
    cueBtn.setPointerCapture(e.pointerId);
    deck?.cuePress();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) cueBtn.addEventListener(type, cueUp);
  cueBtn.addEventListener('keydown', (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      cueDown = true;
      deck?.cuePress();
    }
  });
  cueBtn.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') cueUp();
  });
  cueBtn.addEventListener('blur', cueUp);

  function syncEnabled() {
    const on = !!deck && deck.loaded;
    cueBtn.disabled = playBtn.disabled = !on;
  }

  function syncPlay() {
    const playing = !!deck && deck.playing;
    playBtn.textContent = playing ? 'PAUSE' : 'PLAY';
    playBtn.classList.toggle('on', playing);
    playBtn.setAttribute('aria-pressed', String(playing));
  }

  function syncTitle() {
    if (!deck) return;
    root.classList.toggle('loading', deck.loading);
    if (deck.loading) titleEl.textContent = 'Decoding…';
    else titleEl.textContent = deck.track ? deck.track.name : 'No track loaded';
    titleEl.title = deck.track ? deck.track.name : '';
  }

  return {
    id,
    root,
    /** Bind the audio-side Deck. */
    attach(d) {
      deck = d;
      d.addEventListener('loading', () => {
        loadBtn.disabled = d.loading;
        syncTitle();
      });
      d.addEventListener('track', () => {
        syncTitle();
        syncEnabled();
        shown = { e: '', r: '' };
      });
      d.addEventListener('playstate', syncPlay);
      d.addEventListener('error', () => {
        syncTitle();
      });
      syncTitle();
      syncEnabled();
      syncPlay();
    },
    /** Per-frame readout update (called from requestAnimationFrame). */
    tick() {
      if (!deck || !deck.loaded) return;
      const pos = deck.position;
      const e = formatTime(pos);
      const r = formatRemaining(deck.duration - pos);
      if (e !== shown.e) elapsedEl.textContent = shown.e = e;
      if (r !== shown.r) remainingEl.textContent = shown.r = r;
    },
  };
}
