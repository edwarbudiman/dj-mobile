// Deck AudioWorkletProcessor.
//
// Owns the track samples and a custom fractional playhead (in *track* frames).
// Playback rate is signed (negative = reverse) and smoothed; reads use 4-point
// Catmull-Rom (cubic Hermite) interpolation. Every discontinuity (play, pause, seek, load,
// reaching a track edge) is hidden behind a short gain ramp, so there are no clicks.
// A "scratch target" mode makes the playhead chase an externally supplied position
// (used by the M3 platter) instead of running freely.
//
// Self-contained on purpose: no imports, so it loads in any AudioWorklet implementation.
//
// Messages in  (main -> worklet):
//   { type:'load', left:Float32Array, right:Float32Array|null, sampleRate }  buffers are transferred;
//                                          if audio is playing the old track fades out first
//   { type:'unload' }
//   { type:'play' } | { type:'pause' }
//   { type:'seek', time }                  seconds in track time (ignored unless finite)
//   { type:'rate', value }                 signed playback rate, 1 = normal speed, -1 = reverse
//   { type:'scratch', target }             seconds in track time, or null to release (ignored unless finite)
// Messages out (worklet -> main):
//   { type:'pos', pos, ctxTime, speed }    pos seconds; ctxTime = context time of that pos;
//                                          speed = track-seconds per context-second (0 when stopped)
//   { type:'ended', pos, edge }            faded out at the 'end' or 'start' of the track

const RAMP_SECONDS = 0.006; // play/pause/seek/edge gain ramp
const RATE_TAU = 0.004; // playback-rate smoothing time constant
const SCRATCH_TAU = 0.01; // how tightly the playhead chases the scratch target
const GATE_TAU = 0.003; // smoothing of the near-zero-speed silence gate (>= 2 ms)
const MAX_SCRATCH_RATE = 16; // clamp on chase speed, in multiples of normal speed
const MAX_RATE = 32;
const REPORT_FRAMES = 1024; // ~43-47 Hz at 44.1/48 kHz
const SILENCE_BELOW = 0.01; // |rate| below this is silent; full level above SILENCE_BELOW + SILENCE_SPAN
const SILENCE_SPAN = 0.04;

function hermite(y0, y1, y2, y3, t) {
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * t + c2) * t + c1) * t + y1;
}

function speedGate(speed) {
  return speed >= SILENCE_BELOW + SILENCE_SPAN ? 1 : speed <= SILENCE_BELOW ? 0 : (speed - SILENCE_BELOW) / SILENCE_SPAN;
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
    this.gate = 1;
    this.pendingSeek = null; // track frames
    this.pendingLoad = null; // load message waiting for the fade-out
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
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'load':
      case 'unload':
        // Swap only while silent: fade out first if audio is currently audible.
        if (!this.left || this.gain === 0) this.applyLoad(m);
        else this.pendingLoad = m;
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
        if (this.left && Number.isFinite(m.time)) this.pendingSeek = this.clampFrame(m.time * this.trackRate);
        break;
      case 'rate':
        if (Number.isFinite(m.value)) this.rateTarget = Math.max(-MAX_RATE, Math.min(MAX_RATE, m.value));
        break;
      case 'scratch':
        if (m.target === null || m.target === undefined) this.scratchTarget = null;
        else if (this.left && Number.isFinite(m.target)) this.scratchTarget = this.clampFrame(m.target * this.trackRate);
        break;
    }
    this.dirty = true;
  }

  applyLoad(m) {
    const ok = m.type === 'load' && m.left instanceof Float32Array && m.left.length > 1;
    this.left = ok ? m.left : null;
    this.right = ok ? (m.right instanceof Float32Array && m.right.length === m.left.length ? m.right : m.left) : null;
    this.length = ok ? m.left.length : 0;
    this.trackRate = ok && Number.isFinite(m.sampleRate) && m.sampleRate > 0 ? m.sampleRate : sampleRate;
    this.pos = 0;
    this.playing = false;
    this.gain = 0;
    this.gate = 1;
    this.rate = this.rateTarget;
    this.pendingSeek = null;
    this.pendingLoad = null;
    this.scratchTarget = null;
    this.lastSpeed = 0;
    this.dirty = true;
  }

  clampFrame(f) {
    if (!Number.isFinite(f)) return 0;
    const last = this.length - 1;
    return f < 0 ? 0 : f > last ? last : f;
  }

  // Interpolated stereo read at fractional frame `p`; result in this.outL / this.outR.
  read(p) {
    const last = this.length - 1;
    const i = Math.floor(p);
    const t = p - i;
    const a = i < 1 ? 0 : i - 1 > last ? last : i - 1;
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

    const step = 1 / (RAMP_SECONDS * sampleRate);
    const rateAlpha = 1 - Math.exp(-1 / (RATE_TAU * sampleRate));
    const scratchAlpha = 1 - Math.exp(-1 / (SCRATCH_TAU * sampleRate));
    const gateAlpha = 1 - Math.exp(-1 / (GATE_TAU * sampleRate));
    let ratio = this.trackRate / sampleRate; // track frames per output frame at rate 1
    let maxDelta = MAX_SCRATCH_RATE * ratio;
    let last = this.length - 1;
    const scratching = this.scratchTarget !== null;
    const wasMoving = this.gain > 0;

    let pos = Number.isFinite(this.pos) ? this.pos : 0;
    let gain = Number.isFinite(this.gain) ? this.gain : 0;
    let rate = Number.isFinite(this.rate) ? this.rate : this.rateTarget;
    let gate = Number.isFinite(this.gate) ? this.gate : 1;
    let delta = 0;

    for (let i = 0; i < n; i++) {
      const wantOn = (this.playing || scratching) && this.pendingSeek === null && this.pendingLoad === null;
      let target = wantOn ? 1 : 0;

      // Free-running near a track edge: start fading early enough that gain hits 0 at the edge.
      let edgeStop = false;
      if (wantOn && !scratching) {
        const d = rate * ratio;
        if (d !== 0) {
          const remain = d > 0 ? last - pos : pos;
          const ad = d > 0 ? d : -d;
          if (remain / ad <= gain / step + 1) {
            target = 0;
            edgeStop = true;
          }
        }
      }

      if (gain < target) gain = Math.min(target, gain + step);
      else if (gain > target) gain = Math.max(target, gain - step);

      if (gain === 0) {
        // Silent: the only moment it is safe to jump, swap buffers, or stop at an edge.
        if (edgeStop) {
          pos = rate >= 0 ? last : 0;
          this.playing = false;
          this.dirty = true;
          this.port.postMessage({ type: 'ended', pos: pos / this.trackRate, edge: rate >= 0 ? 'end' : 'start' });
        }
        if (this.pendingLoad !== null) {
          this.applyLoad(this.pendingLoad);
          pos = this.pos;
          gain = this.gain;
          rate = this.rate;
          gate = this.gate;
          break; // sample rate / length may have changed; resume on the next block
        }
        if (this.pendingSeek !== null) {
          pos = this.pendingSeek;
          this.pendingSeek = null;
          this.dirty = true;
        }
        gate = speedGate(rate < 0 ? -rate : rate);
        continue;
      }

      if (scratching) {
        delta = (this.scratchTarget - pos) * scratchAlpha;
        if (delta > maxDelta) delta = maxDelta;
        else if (delta < -maxDelta) delta = -maxDelta;
        rate = delta / ratio; // so a release continues from the scratch speed
      } else {
        rate += (this.rateTarget - rate) * rateAlpha;
        delta = rate * ratio;
      }

      // Smoothed silence gate: a stalled platter fades to silence instead of holding a DC level,
      // and a direction reversal (rate passing through 0) never produces a step.
      gate += (speedGate(rate < 0 ? -rate : rate) - gate) * gateAlpha;

      this.read(pos);
      const g = gain * gate;
      outL[i] = this.outL * g;
      outR[i] = this.outR * g;
      pos += delta;
    }

    this.pos = pos;
    this.gain = gain;
    this.rate = rate;
    this.gate = gate;
    this.lastSpeed = gain > 0 ? rate : 0; // rate is already track-seconds per context-second
    if (wasMoving && gain === 0) this.dirty = true;

    this.sinceReport += n;
    if (this.dirty || (gain > 0 && this.sinceReport >= REPORT_FRAMES)) {
      this.dirty = false;
      this.sinceReport = 0;
      this.port.postMessage({
        type: 'pos',
        pos: this.trackRate > 0 ? pos / this.trackRate : 0,
        ctxTime: currentTime + n / sampleRate,
        speed: this.lastSpeed,
      });
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
