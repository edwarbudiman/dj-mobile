// Mixer panel: per-deck 3-band EQ + channel volume, master, crossfader.
// Pure view: reports changes through handlers, holds no audio objects.

import { FADER_UNITY } from '../audio/mixer-math.js';
import { createFader } from './fader.js';

/**
 * @param {HTMLElement} root
 * @param {{
 *   onEq:(deck:string, band:'high'|'mid'|'low', v:number)=>void,
 *   onVolume:(deck:string, v:number)=>void,
 *   onMaster:(v:number)=>void,
 *   onCrossfader:(v:number)=>void,
 * }} h
 */
export function createMixerView(root, h) {
  root.innerHTML = `
    <div class="mix-eq" data-area="eqa"></div>
    <div class="mix-eq" data-area="eqb"></div>
    <div class="mix-levels" data-area="lv"></div>
    <div class="mix-xf" data-area="xf"></div>`;
  const q = (a) => root.querySelector(`[data-area="${a}"]`);
  const faders = { A: {}, B: {} };

  for (const [id, area] of [['A', 'eqa'], ['B', 'eqb']]) {
    for (const [band, label] of [['high', 'HI'], ['mid', 'MID'], ['low', 'LOW']]) {
      const f = createFader({
        label: `${label} ${id}`,
        value: FADER_UNITY,
        defaultValue: FADER_UNITY,
        onInput: (v) => h.onEq(id, band, v),
      });
      f.el.querySelector('.fader-label').textContent = label;
      f.el.classList.add(`deck-${id.toLowerCase()}`);
      q(area).appendChild(f.el);
      faders[id][band] = f;
    }
  }

  const lv = q('lv');
  const volA = createFader({ label: 'VOL A', value: FADER_UNITY, defaultValue: FADER_UNITY, onInput: (v) => h.onVolume('A', v) });
  const master = createFader({ label: 'MASTER', value: FADER_UNITY, defaultValue: FADER_UNITY, onInput: h.onMaster });
  const volB = createFader({ label: 'VOL B', value: FADER_UNITY, defaultValue: FADER_UNITY, onInput: (v) => h.onVolume('B', v) });
  volA.el.classList.add('deck-a');
  volB.el.classList.add('deck-b');
  lv.append(volA.el, master.el, volB.el);
  faders.A.volume = volA;
  faders.B.volume = volB;

  const xf = createFader({
    label: 'A  ◂  CROSSFADER  ▸  B',
    orientation: 'horizontal',
    value: 0.5,
    defaultValue: 0.5,
    snap: 0.03,
    onInput: h.onCrossfader,
  });
  q('xf').appendChild(xf.el);

  return { faders, master, crossfader: xf };
}
