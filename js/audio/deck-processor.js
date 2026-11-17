// Deck AudioWorkletProcessor.
//
// Owns the track samples and a custom fractional playhead (in *track* frames).
// Playback rate is signed (negative = reverse) and smoothed; reads use 4-point
// Catmull-Rom (cubic Hermite) interpolation. Play/pause/seek go through a short
// gain ramp so there are no clicks. A "scratch target" mode makes the playhead chase
// an externally supplied position (used by the M3 platter) instead of running freely.
//
// Self-contained on purpose: no imports, so it loads in any AudioWorklet implementation.
//
// Messages in  (main -> worklet):
//   { type:'load', left:Float32Array, right:Float32Array|null, sampleRate }  buffers are transferred
//   { type:'unload' }
//   { type:'play' } | { type:'pause' }
//   { type:'seek', time }                  seconds in track time
//   { type:'rate', value }                 signed playback rate, 1 = normal speed, -1 = reverse
//   { type:'scratch', target }             seconds in track time, or null to release
// Messages out (worklet -> main):
//   { type:'pos', pos, ctxTime, speed }    pos seconds; ctxTime = context time of that pos;
//                                          speed = track-seconds per context-second (0 when stopped)
//   { type:'ended', pos, edge }            hit 'end' or 'start' of the track while free-running

const RAMP_SECONDS = 0.006; // play/pause/seek gain ramp
const RATE_TAU = 0.004; // playback-rate smoothing time constant
const SCRATCH_TAU = 0.01; // how tightly the playhead chases the scratch target
const MAX_SCRATCH_RATE = 16; // clamp on chase speed, in multiples of normal speed
const REPORT_FRAMES = 1024; // ~43-47 Hz at 44.1/48 kHz
const SILENCE_BELOW = 0.01; // |rate| below this is silent; full level above SILENCE_BELOW + SILENCE_SPAN
const SILENCE_SPAN = 0.04;

function hermite(y0, y1, y2, y3, t) {
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + y1;
}

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = null;
    this.right = null; // same array as left for mono tracks (no duplicate in memory)
    this.length = 0;
    this.trackRate = sampleRate; // sample rate of the loaded track
    this.pos = 0; // fractional playhead, track frames
    this.playing = false;
    this.gain = 0;
    this.pendingSeek = null; // track frames
    this.rate = 1; // current smoothed rate
    this.rateTarget = 1;
    this.scratchTarget = null; // track frames
    this.sinceReport = 0;
    this.dirty = false;
    this.lastSpeed = 0;
    this.outL = 0;
    this.outR = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.left = m.left;
        this.right = m.right || m.left;
        this.length = m.left.length;
        this.trackRate = m.sampleRate || sampleRate;
        this.pos = 0;
        this.playing = false;
        this.gain = 0;
        this.pendingSeek = null;
        this.scratchTarget = null;
        this.lastSpeed = 0;
        break;
      case 'unload':
        this.left = this.right = null;
        this.length = 0;
        this.playing = false;
        this.gain = 0;
        this.pendingSeek = null;
        this.scratchTarget = null;
        this.lastSpeed = 0;
        break;
      case 'play':
        if (!this.left) break;
        this.playing = true;
        // Restart from the opposite edge if play is pressed at the end of the track.
        if (this.pendingSeek === null) {
          if (this.rateTarget >= 0 && this.pos >= this.length - 1) this.pendingSeek = 0;
          else if (this.rateTarget < 0 && this.pos <= 0) this.pendingSeek = this.length - 1;
        }
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek':
        if (this.left) this.pendingSeek = this.clampFrame(m.time * this.trackRate);
        break;
      case 'rate':
        if (Number.isFinite(m.value)) this.rateTarget = m.value;
        break;
      case 'scratch':
        if (m.target === null || m.target === undefined) this.scratchTarget = null;
        else if (this.left) this.scratchTarget = this.clampFrame(m.target * this.trackRate);
        break;
    }
    this.dirty = true;
  }

  clampFrame(f) {
    const last = this.length - 1;
    return f < 0 ? 0 : f > last ? last : f;
  }

  // Interpolated stereo read at fractional frame `p`; result in this.outL / this.outR.
  read(p) {
    const last = this.length - 1;
    const i = Math.floor(p);
    const t = p - i;
    const a = i < 1 ? 0 : i - 1;
    const b = i < 0 ? 0 : i > last ? last : i;
    const c = i + 1 > last ? last : i + 1 < 0 ? 0 : i + 1;
    const d = i + 2 > last ? last : i + 2 < 0 ? 0 : i + 2;
    const L = this.left;
    const R = this.right;
    this.outL = hermite(L[a], L[b], L[c], L[d], t);
    this.outR = R === L ? this.outL : hermite(R[a], R[b], R[c], R[d], t);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;
    if (!this.left) return true;

    const ratio = this.trackRate / sampleRate; // track frames per output frame at rate 1
    const step = 1 / (RAMP_SECONDS * sampleRate);
    const rateAlpha = 1 - Math.exp(-1 / (RATE_TAU * sampleRate));
    const scratchAlpha = 1 - Math.exp(-1 / (SCRATCH_TAU * sampleRate));
    const maxDelta = MAX_SCRATCH_RATE * ratio;
    const last = this.length - 1;
    const scratching = this.scratchTarget !== null;
    const wasMoving = this.gain > 0;

    let pos = this.pos;
    let gain = this.gain;
    let rate = this.rate;
    let delta = 0;

    for (let i = 0; i < n; i++) {
      const target = (this.playing || scratching) && this.pendingSeek === null ? 1 : 0;
      if (gain < target) gain = Math.min(target, gain + step);
      else if (gain > target) gain = Math.max(target, gain - step);

      // Seeks land only while silent, so the jump is never audible.
      if (this.pendingSeek !== null && gain === 0) {
        pos = this.pendingSeek;
        this.pendingSeek = null;
        this.dirty = true;
        continue;
      }
      if (gain === 0) continue;

      if (scratching) {
        delta = (this.scratchTarget - pos) * scratchAlpha;
        if (delta > maxDelta) delta = maxDelta;
        else if (delta < -maxDelta) delta = -maxDelta;
        rate = delta / ratio; // so a release continues from the scratch speed
      } else {
        rate += (this.rateTarget - rate) * rateAlpha;
        delta = rate * ratio;
        if ((delta > 0 && pos >= last) || (delta < 0 && pos <= 0)) {
          const edge = delta > 0 ? 'end' : 'start';
          pos = delta > 0 ? last : 0;
          this.playing = false;
          gain = 0;
          this.dirty = true;
          this.port.postMessage({ type: 'ended', pos: pos / this.trackRate, edge });
          break;
        }
      }

      const speed = rate < 0 ? -rate : rate;
      const sg = speed >= SILENCE_BELOW + SILENCE_SPAN ? 1 : speed <= SILENCE_BELOW ? 0 : (speed - SILENCE_BELOW) / SILENCE_SPAN;
      if (sg > 0) {
        this.read(pos);
        const g = gain * sg;
        outL[i] = this.outL * g;
        outR[i] = this.outR * g;
      }
      pos += delta;
    }

    this.pos = pos;
    this.gain = gain;
    this.rate = rate;
    this.lastSpeed = gain > 0 ? rate : 0; // rate is already track-seconds per context-second
    if (wasMoving && gain === 0) this.dirty = true;

    this.sinceReport += n;
    if (this.dirty || (gain > 0 && this.sinceReport >= REPORT_FRAMES)) {
      this.dirty = false;
      this.sinceReport = 0;
      this.port.postMessage({
        type: 'pos',
        pos: pos / this.trackRate,
        ctxTime: currentTime + n / sampleRate,
        speed: this.lastSpeed,
      });
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
