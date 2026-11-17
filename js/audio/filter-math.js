// Pure DJ-filter math. No DOM, no Web Audio.
//
// One bipolar knob per deck, position 0..1 with 0.5 = centre (off).
//   left of centre  -> low-pass sweep (cuts the highs, 'muffles')
//   right of centre -> high-pass sweep (cuts the lows, 'thins')
// A dead zone around the centre keeps the filter fully out of the way: the low-pass sits at the
// Nyquist frequency (a unity pass-through in every Web Audio implementation) and the high-pass at 5 Hz
// (-0.02 dB at 20 Hz), so the centre position is transparent.
// Resonance is tame. NOTE: for Web Audio lowpass/highpass biquads, Q is in DECIBELS (the gain at the cutoff),
// not the usual linear Q. Q_FLAT = -3.01 dB is the Butterworth-flat response (linear Q 0.707); it rises to
// Q_MAX = +4.5 dB of resonant peak at the end of the sweep.

export const FILTER_CENTRE = 0.5;
export const FILTER_DEAD = 0.04; // half-width of the dead zone, in knob positions
export const LP_MIN_HZ = 80; // low-pass at full left
export const HP_MIN_HZ = 30; // high-pass just outside the dead zone
export const HP_MAX_HZ = 7000; // high-pass at full right
export const HP_OFF_HZ = 5; // high-pass when bypassed
export const Q_FLAT = -3.01; // dB at the cutoff: maximally flat (Butterworth)
export const Q_MAX = 4.5; // dB at the cutoff at full sweep

const clamp01 = (v) => (v >= 0 ? (v > 1 ? 1 : v) : 0); // NaN -> 0

/** Knob position -> signed sweep amount x in [-1, 1] (0 inside the dead zone). */
export function filterAmount(pos) {
  const p = Number.isFinite(pos) ? clamp01(pos) : FILTER_CENTRE;
  const d = p - FILTER_CENTRE;
  const m = Math.abs(d);
  if (m <= FILTER_DEAD + 1e-9) return 0; // (0.54 - 0.5 is 0.04 plus float dust)
  const x = (m - FILTER_DEAD) / (0.5 - FILTER_DEAD);
  return d < 0 ? -x : x;
}

/**
 * @param {number} pos      knob position 0..1
 * @param {number} nyquist  half the context sample rate (Hz)
 * @returns {{x:number, active:boolean, lpHz:number, lpQ:number, hpHz:number, hpQ:number}}  Q values in dB (see above)
 */
export function filterParams(pos, nyquist = 22050) {
  const x = filterAmount(pos);
  const mag = Math.abs(x);
  const q = Q_FLAT + (Q_MAX - Q_FLAT) * Math.pow(mag, 1.5);
  let lpHz = nyquist;
  let hpHz = HP_OFF_HZ;
  let lpQ = Q_FLAT;
  let hpQ = Q_FLAT;
  if (x < 0) {
    lpHz = nyquist * Math.pow(LP_MIN_HZ / nyquist, mag);
    lpQ = q;
  } else if (x > 0) {
    hpHz = HP_MIN_HZ * Math.pow(HP_MAX_HZ / HP_MIN_HZ, mag);
    hpQ = q;
  }
  return { x, active: x !== 0, lpHz, lpQ, hpHz, hpQ };
}
