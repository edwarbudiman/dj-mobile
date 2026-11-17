// Mixer panel (190 px wide): per-deck 3-band EQ knobs, channel volume faders, crossfader.
// Layout:   [ EQ A ][ VOL A ][ VOL B ][ EQ B ]   four 44 px columns
// Master volume and pitch range live in the library/settings sheet.
// Pure view: reports changes through handlers, holds no audio objects.

import { FADER_UNITY } from '../audio/mixer-math.js';
import { createFader } from './fader.js';
import { createKnob } from './knob.js';

/**
 * @param {HTMLElement} root
 * @param {{
 *   onEq:(deck:string, band:'high'|'mid'|'low', v:number)=>void,
 *   onVolume:(deck:string, v:number)=>void,
 *   onCrossfader:(v:number)=>void,
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
  }

  for (const [id, area] of [['A', 'vola'], ['B', 'volb']]) {
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

  return { controls, crossfader: xf, libButton: root.querySelector('.btn-lib-mix') };
}
