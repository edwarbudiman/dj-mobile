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
//   { type:'scratch', target|delta, t }    grab/move: `target` = absolute seconds, or `delta` = seconds relative to
//                                          the current scratch target (or to the playhead on the first message,
//                                          which stops the record under the finger). `t` = time in seconds of the
//                                          pointer event on any monotonic clock (only differences are used, to
//                                          estimate the event interval; optional). Non-finite values are ignored.
//   { type:'scratch', target:null }        release. Playing: the motor spins the record back up to the play
//                                          rate (MOTOR_TAU). Paused: the record settles on the last target and
//                                          stays there.
//
// Scratch signal chain (finger -> sound): the finger velocity is measured from event timestamps (delta / dt)
// and a reference position moves toward the latest target at that velocity (a 60 Hz drag becomes a ramp,
// not a staircase), with a weak backlog term (SCRATCH_CORRECT) so it never drifts and a stopped finger
// settles quickly. The playhead follows the reference through a one-pole low-pass (SCRATCH_TAU), which
// rounds the velocity corners. Steady added lag = one event interval + SCRATCH_TAU
// (about 21 ms at 60 Hz, 12 ms at 120 Hz). Rate is capped at MAX_SCRATCH_RATE.
// Edges: the playhead clamps at 0 / last without a click and without posting 'ended'; only free-running
// play (including the spin-up after a release) reaching the end of the track ends playback.
//   { type:'loop', on:true, start, end }   loop [start, end) seconds (track time). Free-running playback
//                                          wraps sample-accurately at the seam (forward at `end`, reverse at
//                                          `start`); the position is folded into the loop by whole loop
//                                          lengths, so the length is exact over any number of repeats. The seam
//                                          is a LOOP_XFADE_SECONDS equal-level crossfade: after the wrap, the
//                                          audio that would have played on (the "ghost") fades out while the
//                                          wrapped audio fades in, so there is no step. The loop is in track
//                                          time, so pitch changes do not alter it. While a finger holds the
//                                          record the loop is suspended; on release the loop continues if the
//                                          record is inside it, otherwise the loop is dropped.
//   { type:'loop', on:false }              exit: playback just carries on past the loop end
//                                          Invalid loops (non-finite, shorter than 20 ms, outside the track,
//                                          too close to the track end for the crossfade) are ignored.
// Messages out (worklet -> main):
//   { type:'pos', pos, ctxTime, speed, wrap, wrapLen }
//                                          pos seconds; ctxTime = context time of that pos;
//                                          speed = track-seconds per context-second (0 when stopped);
//                                          wrap = context time at which the most recent loop wrap happened
//                                          (-1 if none since the last seek / grab / loop set / load) and wrapLen
//                                          = how far (track seconds) that wrap moved the position. The main
//                                          thread needs this to place the audio the LISTENER hears (output latency
//                                          behind the engine): heard times earlier than `wrap` are on the previous
//                                          repeat. It stays valid after a loop exit.
//   { type:'ended', pos, edge }            faded out at the 'end' or 'start' of the track
//   { type:'loop', on:false, reason }      the loop was dropped by the processor: a seek or a scratch release
//                                          landed outside it ('seek' | 'scratch')

const RAMP_SECONDS = 0.006; // play/pause/seek/edge gain ramp
const LOOP_XFADE_SECONDS = 0.008; // loop seam crossfade (loop-math.js LOOP_XFADE mirrors this)
const LOOP_MIN_SECONDS = 0.02;
const RATE_TAU = 0.004; // playback-rate smoothing time constant
const SCRATCH_TAU = 0.004; // playhead follows the glide reference with this lag (velocity low-pass)
const MOTOR_TAU = 0.03; // release spin-up: rate settles on the play rate (95 % in ~90 ms); mirrors scratch-math.js
const BRAKE_TAU = 0.012; // released while paused: leftover speed dies out this fast
const GATE_TAU = 0.003; // smoothing of the near-zero-speed silence gate when it closes (>= 2 ms)
const GATE_ATTACK_TAU = 0.00012; // ...and when it opens again
const MAX_SCRATCH_RATE = 8; // clamp on chase speed, in multiples of normal speed
const SCRATCH_DT_DEFAULT = 1 / 60; // event interval assumed until measured
const SCRATCH_DT_MIN = 0.004;
const SCRATCH_DT_MAX = 0.03;
const SCRATCH_EXTRAP = 0.008; // how long the reference may coast past a target while the next event is late
const SCRATCH_PULL = 0.015; // seconds to ease back onto the finger after coasting past it
const PULL_MUTE_TAU = 0.002; // fade-out of the stop-bounce crawl so a stopped record stays silent...
const PULL_MUTE_INTERVALS = 1.1; // ...once no event has arrived for this many event intervals
const PULL_MUTE_COAST_INTERVALS = 1.25; // ...or this many, once the reference has also coasted out and is easing back
const PULL_UNMUTE_TAU = 0.0005; // level comes back this fast when events resume
const SCRATCH_CORRECT = 0.03; // seconds over which the reference works off its backlog (weak position term)
const REPORT_FRAMES_FAST = 256; // position reports while scratching / spinning up (~5 ms)
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
    this.scratchTarget = null; // track frames: where the finger is
    this.scratchRef = 0; // glide reference position, track frames
    this.scratchRefVel = 0; // reference speed, track frames per output frame
    this.scratchVel = 0; // smoothed finger velocity, track frames per second
    this.scratchOver = 0; // frames the reference may coast past the target
    this.scratchVPrev = 0; // previous event's measured velocity
    this.scratchPull = 0; // easing back onto the target: 0 no, 1 after a reversal, 2 after coasting past a stopped finger
    this.pullGain = 1; // fades out while a stopped record crawls back onto the finger
    this.scratchInterval = SCRATCH_DT_DEFAULT; // smoothed pointer event interval, seconds
    this.scratchLastT = NaN; // context time of the previous event
    this.scratchHaveEvent = false;
    this.sinceEvent = 0; // output frames since the previous event (fallback interval estimate)
    this.releasing = false; // release requested; finalised when it can no longer be heard
    this.spinUp = false; // motor ramp to the play rate after a release
    this.braking = false; // released while paused: bleed off the leftover speed
    this.sinceReport = 0;
    this.dirty = false;
    this.lastSpeed = 0;
    this.outL = 0;
    this.outR = 0;
    this.loopOn = false;
    this.loopStart = 0; // track frames
    this.loopEnd = 0;
    this.loopLen = 0;
    this.loopGhost = 0; // where the audio would be without the wrap, while the seam crossfades
    this.loopXfLeft = 0; // output frames of seam crossfade still to run
    this.loopWrapTime = -1; // context time of the most recent wrap (-1: none since the last seek / grab / loop set / load)
    this.loopWrapLen = 0; // the loop length (track seconds) that wrap folded by
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
        if (this.braking) {
          this.braking = false;
          this.spinUp = true;
        }
        // Restart from the opposite edge if play is pressed at the end of the track (never mid-scratch).
        if (this.pendingSeek === null && this.scratchTarget === null) {
          if (this.rateTarget >= 0 && this.pos >= this.length - 1) this.pendingSeek = 0;
          else if (this.rateTarget < 0 && this.pos <= 0) this.pendingSeek = this.length - 1;
        }
        break;
      case 'pause':
        this.playing = false;
        break;
      case 'seek':
        // The hand wins: a seek never interrupts a grab.
        if (this.left && this.scratchTarget === null && Number.isFinite(m.time)) this.pendingSeek = this.clampFrame(m.time * this.trackRate);
        break;
      case 'rate':
        if (Number.isFinite(m.value)) this.rateTarget = Math.max(-MAX_RATE, Math.min(MAX_RATE, m.value));
        break;
      case 'scratch':
        this.onScratch(m);
        break;
      case 'loop':
        this.onLoop(m);
        break;
    }
    this.dirty = true;
  }

  onLoop(m) {
    if (m.on === false) {
      this.loopOn = false; // a seam crossfade already running finishes by itself
      return;
    }
    if (!this.left || !Number.isFinite(m.start) || !Number.isFinite(m.end)) return;
    const s = m.start * this.trackRate;
    const e = m.end * this.trackRate;
    if (!(s >= 0) || !(e - s >= LOOP_MIN_SECONDS * this.trackRate)) return;
    if (e + LOOP_XFADE_SECONDS * this.trackRate > this.length - 1) return;
    this.loopStart = s;
    this.loopEnd = e;
    this.loopLen = e - s;
    this.loopOn = true;
    this.loopWrapTime = -1; // a new loop has not wrapped yet: entering it is not a wrap
  }

  dropLoop(reason) {
    this.loopOn = false;
    this.loopXfLeft = 0;
    this.port.postMessage({ type: 'loop', on: false, reason });
  }

  onScratch(m) {
    if (m.target === null || (m.target === undefined && m.delta === undefined)) {
      if (this.scratchTarget !== null) this.releasing = true;
      return;
    }
    if (!this.left) return;
    const grabbing = this.scratchTarget === null;
    // `at` (grab only): the position the listener actually hears under the finger, which lags the engine
    // position by the output latency. The record fades out, jumps there while silent, and scratches on.
    const at = grabbing && Number.isFinite(m.at) ? this.clampFrame(m.at * this.trackRate) : NaN;
    let goal;
    if (Number.isFinite(m.target)) goal = m.target * this.trackRate;
    else if (Number.isFinite(m.delta)) goal = (!grabbing ? this.scratchTarget : at === at ? at : this.pos) + m.delta * this.trackRate;
    else return;
    goal = this.clampFrame(goal);

    if (grabbing) {
      // Grab: the record stops under the finger where it is (or where it is heard, with `at`).
      this.scratchRef = Number.isFinite(this.pos) ? this.pos : 0;
      this.scratchRefVel = 0;
      this.scratchVel = 0;
      this.scratchOver = 0;
      this.scratchVPrev = 0;
      this.scratchHaveEvent = false;
      this.scratchLastT = NaN;
      this.braking = false;
      this.spinUp = false;
      this.loopXfLeft = 0; // the hand takes over: no seam crossfade runs under it
      this.loopWrapTime = -1;
      this.pendingSeek = at === at ? at : null;
    }
    this.releasing = false;
    this.scratchPull = 0;

    // Time since the previous event, from the pointer timestamps (immune to delivery jitter and to the
    // 128-frame block quantisation of message handling); falls back to counted frames.
    let dt = NaN;
    if (this.scratchHaveEvent) {
      dt = Number.isFinite(m.t) && Number.isFinite(this.scratchLastT) ? m.t - this.scratchLastT : this.sinceEvent / sampleRate;
    }
    this.scratchLastT = Number.isFinite(m.t) ? m.t : NaN;
    this.scratchHaveEvent = true;
    this.sinceEvent = 0;
    if (dt > 0.001 && dt < 0.08) {
      const c = dt < SCRATCH_DT_MIN ? SCRATCH_DT_MIN : dt > SCRATCH_DT_MAX ? SCRATCH_DT_MAX : dt;
      this.scratchInterval += (c - this.scratchInterval) * 0.25;
    } else {
      dt = this.scratchInterval; // first event, a pause, or a bad stamp
    }
    dt = dt < SCRATCH_DT_MIN ? SCRATCH_DT_MIN : dt > SCRATCH_DT_MAX ? SCRATCH_DT_MAX : dt;

    // Finger velocity over this interval (frames per second), lightly smoothed. The reference glides at
    // that velocity, plus a weak pull that works off the backlog beyond the steady one-interval lag, so
    // the reference never drifts away from the finger.
    const prev = this.scratchTarget !== null ? this.scratchTarget : this.scratchRef;
    const vCap = MAX_SCRATCH_RATE * this.trackRate;
    let vMeas = (goal - prev) / dt;
    vMeas = vMeas > vCap ? vCap : vMeas < -vCap ? -vCap : vMeas;
    this.scratchVel += (vMeas - this.scratchVel) * 0.5;
    const excess = goal - this.scratchRef - this.scratchVel * this.scratchInterval;
    this.scratchTarget = goal;
    // A late event (jitter, or delivery at the next 128-frame block boundary) must not leave the reference
    // parked on its target, which would dip the speed: it may run on past the target, but for at most
    // SCRATCH_EXTRAP seconds of finger speed, so a stopped finger overshoots by only a few ms of track.
    // Only a velocity that two consecutive events agree on counts, so an isolated jump or the last event of
    // a decelerating finger coasts (almost) not at all.
    const agree = vMeas * this.scratchVPrev > 0 ? Math.min(Math.abs(vMeas), Math.abs(this.scratchVPrev)) : 0;
    this.scratchOver = agree * SCRATCH_EXTRAP;
    this.scratchVPrev = vMeas;
    let rv = (this.scratchVel + excess / SCRATCH_CORRECT) / sampleRate;
    // A direction change can leave the reference moving away from the new target. Never let the loop
    // "arrive" by jumping across the backlog: head for the target at a gentle, bounded speed instead.
    const gap = goal - this.scratchRef;
    if (Math.abs(gap) > 1 && rv * gap < 0) rv = gap / (SCRATCH_CORRECT * sampleRate);
    this.scratchRefVel = rv;
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
    this.releasing = false;
    this.spinUp = false;
    this.braking = false;
    this.loopOn = false;
    this.loopXfLeft = 0;
    this.loopWrapTime = -1;
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
    const motorAlpha = 1 - Math.exp(-1 / (MOTOR_TAU * sampleRate));
    const brakeAlpha = 1 - Math.exp(-1 / (BRAKE_TAU * sampleRate));
    const gateAlpha = 1 - Math.exp(-1 / (GATE_TAU * sampleRate));
    const gateUpAlpha = 1 - Math.exp(-1 / (GATE_ATTACK_TAU * sampleRate));
    let ratio = this.trackRate / sampleRate; // track frames per output frame at rate 1
    let maxDelta = MAX_SCRATCH_RATE * ratio;
    let last = this.length - 1;
    let scratching = this.scratchTarget !== null;
    const wasMoving = this.gain > 0;

    let pos = Number.isFinite(this.pos) ? this.pos : 0;
    let gain = Number.isFinite(this.gain) ? this.gain : 0;
    let rate = Number.isFinite(this.rate) ? this.rate : this.rateTarget;
    let gate = Number.isFinite(this.gate) ? this.gate : 1;
    let ref = this.scratchRef;
    let refVel = this.scratchRefVel;
    const tgt = this.scratchTarget;
    const over = this.scratchOver;
    let pull = this.scratchPull;
    let pg = Number.isFinite(this.pullGain) ? this.pullGain : 1;
    const pgAlpha = 1 - Math.exp(-1 / (PULL_MUTE_TAU * sampleRate));
    const vPrev = this.scratchVPrev;
    const mutePast = PULL_MUTE_INTERVALS * this.scratchInterval * sampleRate;
    const mutePastCoast = PULL_MUTE_COAST_INTERVALS * this.scratchInterval * sampleRate;
    const pgUpAlpha = 1 - Math.exp(-1 / (PULL_UNMUTE_TAU * sampleRate));
    let delta = 0;
    const xfTotal = Math.max(2, Math.round(LOOP_XFADE_SECONDS * sampleRate));
    let xfLeft = this.loopXfLeft;
    let ghost = this.loopGhost;

    for (let i = 0; i < n; i++) {
      // Release: playing -> hand the record to the motor at once; paused -> let the record settle on the
      // finger's last position first (the glide and follower are a few ms behind the finger).
      if (scratching && this.releasing && (this.playing || (refVel === 0 && Math.abs(ref - pos) < 1))) {
        scratching = false;
        this.scratchTarget = null;
        this.releasing = false;
        this.spinUp = this.playing;
        this.braking = !this.playing;
        this.dirty = true;
        // Let go inside the loop: it carries on. Let go outside it: the loop is dropped.
        if (this.loopOn && (pos < this.loopStart || pos >= this.loopEnd)) this.dropLoop('scratch');
      }

      const wantOn = (this.playing || scratching) && this.pendingSeek === null && this.pendingLoad === null;
      let target = wantOn ? 1 : 0;

      // Free-running near a track edge: start fading early enough that gain hits 0 at the edge.
      let edgeStop = false;
      if (wantOn && !scratching) {
        const d = rate * ratio;
        // Momentum carrying the record away from the play direction (spin-up after a backward flick)
        // heads for the far edge, not the end of playback: pos clamps there instead of ending.
        if (d !== 0 && d * this.rateTarget >= 0) {
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
          xfLeft = 0;
          break; // sample rate / length may have changed; resume on the next block
        }
        if (this.pendingSeek !== null) {
          pos = this.pendingSeek;
          this.pendingSeek = null;
          this.dirty = true;
          this.loopXfLeft = 0;
          this.loopWrapTime = -1; // a seek is a jump, not a wrap
          xfLeft = 0;
          if (!scratching && this.loopOn && (pos < this.loopStart || pos >= this.loopEnd)) this.dropLoop('seek');
          if (scratching) {
            // a grab jumped to the heard position: the glide restarts from there
            ref = pos;
            pull = 0;
            refVel = Math.abs(tgt - pos) > 1 ? (tgt - pos) / (SCRATCH_CORRECT * sampleRate) : 0;
            rate = 0;
          }
        }
        if (this.braking) {
          this.braking = false;
          rate = this.rateTarget; // stopped and silent: back to the idle rate
        }
        this.spinUp = false;
        gate = speedGate(rate < 0 ? -rate : rate);
        continue;
      }

      if (scratching) {
        // Glide the reference to the finger, then follow it (low-pass = smooth velocity, no drift).
        if (refVel !== 0) {
          ref += refVel;
          const dir = refVel > 0 ? 1 : -1;
          if (pull) {
            if (dir * (ref - tgt) >= 0) {
              ref = tgt; // back on the finger
              refVel = 0;
              pull = 0;
            }
          } else if (dir * (ref - tgt) >= over) {
            // Arrived (and coasted): wait for the next event. The reference only ever snaps onto the
            // target when that is within one step; otherwise it eases there, so it never jumps.
            const gapAbs = Math.abs(ref - tgt);
            const step = Math.abs(refVel);
            if (gapAbs <= step + 0.5) {
              ref = tgt;
              refVel = 0;
            } else if (gapAbs <= over + step + 1) {
              // coasted past a finger that has stopped: ease back quickly (pull = 2)
              pull = 2;
              refVel = (tgt - ref) / (SCRATCH_PULL * sampleRate);
            } else {
              // moving away from a target that is further off (a reversal): head back at a gentle speed
              pull = 1;
              refVel = (tgt - ref) / (SCRATCH_CORRECT * sampleRate);
            }
          }
        }
        // A grab that must jump to the heard position holds the record while it fades out.
        delta = (ref - pos) * scratchAlpha;
        if (this.pendingSeek !== null) delta = 0;
        if (delta > maxDelta) delta = maxDelta;
        else if (delta < -maxDelta) delta = -maxDelta;
        rate = delta / ratio; // so a release continues from the scratch speed
      } else if (this.braking) {
        rate -= rate * brakeAlpha;
        delta = rate * ratio;
      } else {
        rate += (this.rateTarget - rate) * (this.spinUp ? motorAlpha : rateAlpha);
        if (this.spinUp && Math.abs(this.rateTarget - rate) < 0.002) this.spinUp = false;
        delta = rate * ratio;
      }

      // Smoothed silence gate: a stalled platter fades to silence instead of holding a DC level,
      // and a direction reversal (rate passing through 0) never produces a step.
      // It closes slowly (no tick at a stop) but opens fast, so a reversal does not duck the level.
      const gateGoal = speedGate(rate < 0 ? -rate : rate);
      gate += (gateGoal - gate) * (gateGoal > gate ? gateUpAlpha : gateAlpha);

      this.read(pos);
      if (xfLeft > 0) {
        // Loop seam: blend from the audio that would have played on (ghost) into the wrapped audio.
        const l1 = this.outL;
        const r1 = this.outR;
        this.read(ghost);
        const w = 1 - xfLeft / xfTotal; // weight of the wrapped audio: 0 at the seam, 1 at the end
        this.outL += (l1 - this.outL) * w;
        this.outR += (r1 - this.outR) * w;
        ghost += delta;
        xfLeft--;
      }
      // Stop bounce: when no event has arrived for 1.5 of the measured event intervals, the finger has
      // stopped, and any motion AGAINST the direction it was last moving is the record settling back after
      // coasting past it. That crawl is faded out instead of being heard as a "wow". A real reversal keeps
      // delivering events, so it never reaches this state (and the level returns within ~1 ms of an event).
      const stoppedAhead = scratching && rate * vPrev < 0 && (this.sinceEvent + i > mutePast || (pull === 2 && this.sinceEvent + i > mutePastCoast));
      pg += ((stoppedAhead ? 0 : 1) - pg) * (stoppedAhead ? pgAlpha : pgUpAlpha);
      const g = gain * gate * pg;
      outL[i] = this.outL * g;
      outR[i] = this.outR * g;
      pos += delta;
      if (this.loopOn && !scratching) {
        // Sample-accurate wrap: fold by whole loop lengths so the fractional position (and with it the
        // loop length) never drifts. The ghost carries on from the unwrapped position for the crossfade.
        if (delta > 0 && pos >= this.loopEnd) {
          let k = Math.floor((pos - this.loopStart) / this.loopLen);
          if (k < 1) k = 1;
          ghost = pos;
          xfLeft = xfTotal;
          pos -= k * this.loopLen;
          this.loopWrapTime = currentTime + (i + 1) / sampleRate; // the position jumped between sample i and i + 1
          this.loopWrapLen = (k * this.loopLen) / this.trackRate;
        } else if (delta < 0 && pos < this.loopStart) {
          let k = Math.ceil((this.loopStart - pos) / this.loopLen);
          if (k < 1) k = 1;
          ghost = pos;
          xfLeft = xfTotal;
          pos += k * this.loopLen;
          this.loopWrapTime = currentTime + (i + 1) / sampleRate;
          this.loopWrapLen = (k * this.loopLen) / this.trackRate;
        }
      }
      if (scratching || this.spinUp || this.braking) {
        // Hard clamp at the track edges while the hand or the motor is in charge: no click, no 'ended'.
        // Momentum heading away from the play direction dies at the edge; momentum in the play direction
        // is kept so the free-running edge stop sees it and ends playback normally.
        if (pos < 0) pos = 0;
        else if (pos > last) pos = last;
        else continue;
        if (!scratching && rate * this.rateTarget < 0) rate = 0;
      }
    }

    this.pos = pos;
    this.gain = gain;
    this.rate = rate;
    this.gate = gate;
    this.scratchRef = ref;
    this.scratchRefVel = refVel;
    this.scratchPull = pull;
    this.pullGain = pg;
    this.loopXfLeft = xfLeft;
    this.loopGhost = ghost;
    this.sinceEvent += n;
    const fast = this.scratchTarget !== null || this.spinUp || this.braking;
    this.lastSpeed = gain > 0 ? rate : 0; // rate is already track-seconds per context-second
    if (wasMoving && gain === 0) this.dirty = true;

    this.sinceReport += n;
    if (this.dirty || (gain > 0 && this.sinceReport >= (fast ? REPORT_FRAMES_FAST : REPORT_FRAMES))) {
      this.dirty = false;
      this.sinceReport = 0;
      this.port.postMessage({
        type: 'pos',
        pos: this.trackRate > 0 ? pos / this.trackRate : 0,
        ctxTime: currentTime + n / sampleRate,
        speed: this.lastSpeed,
        wrap: this.loopWrapTime,
        wrapLen: this.loopWrapLen,
      });
    }
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
