// Pure mixer math. No DOM, no Web Audio imports: unit-testable in Node.

export const EQ_MIN_DB = -26; // "kill" end of the EQ range
export const EQ_MAX_DB = 6;
/** Fader/knob position (0..1) that maps to 0 dB. */
export const FADER_UNITY = 0.8;

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * Equal-power crossfader. x: 0 = full deck A, 1 = full deck B.
 * a^2 + b^2 === 1 everywhere, so the summed power stays constant.
 */
export function crossfaderGains(x) {
  const p = clamp(x, 0, 1);
  if (p <= 0) return { a: 1, b: 0 };
  if (p >= 1) return { a: 0, b: 1 };
  const theta = (p * Math.PI) / 2;
  return { a: Math.cos(theta), b: Math.sin(theta) };
}

/**
 * EQ position (0..1) -> dB. 0 = -26 dB (kill), FADER_UNITY = 0 dB, 1 = +6 dB.
 * Linear in dB on each side of unity.
 */
export function eqPositionToDb(v) {
  const p = clamp(v, 0, 1);
  if (p <= FADER_UNITY) return EQ_MIN_DB * (1 - p / FADER_UNITY);
  return (EQ_MAX_DB * (p - FADER_UNITY)) / (1 - FADER_UNITY);
}

/**
 * Volume fader position (0..1) -> linear gain. 0 = silence, FADER_UNITY = 0 dB,
 * 1 = +3 dB. dB-linear taper (-50 dB at the bottom) with a short fade to true zero.
 */
export function faderToGain(v) {
  const p = clamp(v, 0, 1);
  if (p <= 0) return 0;
  const db = p <= FADER_UNITY ? -50 * (1 - p / FADER_UNITY) : (3 * (p - FADER_UNITY)) / (1 - FADER_UNITY);
  return dbToGain(db) * Math.min(1, p / 0.04);
}
