// Mixer panel (190 px wide): per-deck 3-band EQ knobs + filter knob, channel volume faders, crossfader.
// Layout:   [ EQ A ][ VOL A ][ VOL B ][ EQ B ]   four 44 px columns
//   EQ column, top to bottom:  Hi, Mid, Lo, Filter      (4 x 44 px + 3 gaps = 182 px of the 192 px row)
//   Volume column:             [PFL] (only with split headphone cue on), fader
//   Top row: Library, plus the cue/master mix knob when split cue is on.
// Master volume, pitch range and the split-cue switch live in the library/settings sheet.
// Pure view: reports changes through handlers, holds no audio objects.

import { filterAmount } from '../audio/filter-math.js';
import { FADER_UNITY } from '../audio/mixer-math.js';
import { createFader } from './fader.js';
import { createKnob } from './knob.js';

const FILTER_DEAD_ZONE = { at: 0.5, width: 0.04 }; // keep in step with filter-math.js FILTER_DEAD

const filterText = (v) => {
  const x = filterAmount(v);
  if (x === 0) return 'Off';
  return `${x < 0 ? 'Low-pass' : 'High-pass'} ${Math.round(Math.abs(x) * 100)}%`;
};

/**
 * @param {HTMLElement} root
 * @param {{
 *   onEq:(deck:string, band:'high'|'mid'|'low', v:number)=>void,
 *   onFilter:(deck:string, v:number)=>void,
 *   onVolume:(deck:string, v:number)=>void,
 *   onCrossfader:(v:number)=>void,
 *   onPfl:(deck:string, on:boolean)=>void,
 *   onCueMix:(v:number)=>void,
 * }} h
 */
export function createMixerView(root, h) {
  root.innerHTML = `
    <div class="mix-lib"><button type="button" class="btn btn-lib-mix">Library</button></div>
    <div class="mix-col mix-eq deck-a" data-area="eqa"></div>
    <div class="mix-col mix-vol deck-a" data-area="vola"></div>
    <div class="mix-col mix-vol deck-b" data-area="volb"></div>
    <div class="mix-col mix-eq deck-b" data-area="eqb"></div>
    <div class="mix-xf" data-area="xf"></div>`;
  const q = (a) => root.querySelector(`[data-area="${a}"]`);
  const controls = { A: {}, B: {} };

  for (const [id, area] of [['A', 'eqa'], ['B', 'eqb']]) {
    for (const [band, label] of [['high', 'Hi'], ['mid', 'Mid'], ['low', 'Lo']]) {
      const k = createKnob({ label: `${label} ${id}`, value: FADER_UNITY, defaultValue: FADER_UNITY, onInput: (v) => h.onEq(id, band, v) });
      q(area).appendChild(k.el);
      controls[id][band] = k;
    }
    // Filter: centre = off (dead zone), left = low-pass, right = high-pass. Double-tap resets to off.
    const flt = createKnob({
      label: `Filter ${id}`,
      shortName: 'Flt',
      value: 0.5,
      defaultValue: 0.5,
      detent: FILTER_DEAD_ZONE,
      valueText: filterText,
      onInput: (v) => h.onFilter(id, v),
    });
    flt.el.title = 'Filter. Left = low-pass, right = high-pass, centre = off. Double-tap to reset.';
    q(area).appendChild(flt.el);
    controls[id].filter = flt;
  }

  const pfl = {};
  for (const [id, area] of [['A', 'vola'], ['B', 'volb']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-pfl';
    b.hidden = true;
    b.textContent = 'PFL';
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', `Headphone cue, deck ${id}`);
    b.title = 'Listen to this deck in the left ear, before its fader';
    // act on pointerdown (like Play); click with detail 0 covers the keyboard
    const toggle = () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      h.onPfl(id, on);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      toggle();
    });
    b.addEventListener('click', (e) => {
      if (e.detail === 0) toggle();
    });
    q(area).appendChild(b);
    pfl[id] = b;

    const f = createFader({
      label: id,
      value: FADER_UNITY,
      defaultValue: FADER_UNITY,
      onInput: (v) => h.onVolume(id, v),
    });
    f.el.setAttribute('aria-label', `Volume ${id}`);
    q(area).appendChild(f.el);
    controls[id].volume = f;
  }

  const xf = createFader({
    label: 'Crossfader',
    orientation: 'horizontal',
    value: 0.5,
    defaultValue: 0.5,
    snap: 0.03,
    caption: false,
    endLabels: ['A', 'B'],
    onInput: h.onCrossfader,
  });
  q('xf').appendChild(xf.el);

  // Left-ear balance of the split cue: left = cue only, right = master only, centre = both.
  const mixKnob = createKnob({
    label: 'Cue mix',
    shortName: 'Mix',
    value: 0.5,
    defaultValue: 0.5,
    valueText: (v) => (v < 0.05 ? 'Cue only' : v > 0.95 ? 'Master only' : `${Math.round((1 - v) * 100)}% cue, ${Math.round(v * 100)}% master`),
    onInput: h.onCueMix,
  });
  mixKnob.el.title = 'Left ear: turn left for more cue, right for more master.';
  mixKnob.el.hidden = true;
  root.querySelector('.mix-lib').appendChild(mixKnob.el);

  return {
    controls,
    crossfader: xf,
    libButton: root.querySelector('.btn-lib-mix'),
    /** Show or hide the headphone-cue controls (PFL buttons, mix knob). */
    setSplitCue(on) {
      root.classList.toggle('split-cue', !!on);
      for (const b of Object.values(pfl)) b.hidden = !on;
      mixKnob.el.hidden = !on;
    },
    setPfl(id, on) {
      pfl[id]?.setAttribute('aria-pressed', String(!!on));
    },
    setCueMix(v) {
      mixKnob.setValue(v);
    },
    setFilter(id, v) {
      controls[id].filter.setValue(v);
    },
  };
}
