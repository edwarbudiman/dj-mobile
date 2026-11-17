// Main-thread side of a deck: owns the AudioWorkletNode, the per-deck EQ/volume/crossfade
// nodes, decoding + transfer of track data, transport (play, pause, seek, cue) and the tempo
// model (beat grid, pitch, pitch bend).
//
// Events (EventTarget): 'loading' {loading}, 'track' {track|null}, 'playstate' {playing},
// 'cue' {cue}, 'grid' {grid|null, persist}, 'pitch' {pitch, range}, 'ended', 'error' {message},
// 'grab' {grabbed, reason}, 'hotcues' {hotCues, persist}, 'loop' {loop|null, reason}.
//
// Signal path: worklet -> EQ -> filter (low-pass, high-pass) -> volume -> crossfade gain -> master bus,
// with a pre-fader send (PFL) taken right after the filter into the headphone cue bus.
//
// Scratch precedence: while `grabbed` the hand wins. seek() and cuePress() are ignored, play/pause only
// toggle the state (the audio keeps following the hand until release), and rebasing is skipped.

import { HOT_CUE_COUNT, hotCueTime, sanitizeHotCues } from './cue-math.js';
import { Q_FLAT, filterParams } from './filter-math.js';
import { inLoop, planLoop, wrapIntoLoop } from './loop-math.js';
import { clamp, eqPositionToDb, faderToGain } from './mixer-math.js';
import { estimatePosition, isNear } from './playhead-math.js';
import { applyDelta } from './scratch-math.js';
import { effectiveBpm, pitchToRate } from './sync-math.js';

const EQ_BANDS = {
  low: { type: 'lowshelf', frequency: 250 },
  mid: { type: 'peaking', frequency: 1000, Q: 0.7 },
  high: { type: 'highshelf', frequency: 3500 },
};
const SMOOTH = 0.012; // setTargetAtTime constant for control changes
const FILTER_SMOOTH = 0.02; // filter cutoff / resonance glide
export const BEND_AMOUNT = 0.04; // pitch-bend buttons change the rate by 4 %
const OFFSET_DECAY = 0.12; // seconds for the heard-position continuity offset to fade out
const RELEASE_GAP = 0.008; // a scratch release only slides the display when it is more than this far (s) from the heard position
const RELEASE_EASE = 0.07; // ...over about this long (time constant, s)

function decode(ctx, arrayBuffer) {
  // Callback form: works on every Safari, unlike promise-only decodeAudioData.
  return new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuffer, resolve, reject));
}

export class Deck extends EventTarget {
  /**
   * @param {AudioContext} ctx  @param {string} id 'A'|'B'
   * @param {AudioNode} destination master bus input
   * @param {AudioNode} [cueDestination] headphone cue bus input (PFL send)
   */
  constructor(ctx, id, destination, cueDestination) {
    super();
    this.ctx = ctx;
    this.id = id;
    this.track = null; // { name, duration, sampleRate, length, libraryId }
    this.hotCues = new Array(HOT_CUE_COUNT).fill(null); // track seconds or null
    this.loop = null; // { start, end, beats } in track seconds, or null
    this.loadingLabel = 'Decoding…';
    this.pfl = false;
    this.playing = false;
    this.previewing = false;
    this.loading = false;
    this.cue = 0;
    this.grid = null; // { bpm, offset, confidence, source } in track time, or null
    this.analyzing = false;
    this.pitch = 0; // percent
    this.pitchRange = 8; // +/- percent
    this._bend = 0; // -1, 0, +1 while a bend button is held
    this._report = null;
    this._loadToken = 0;
    this._latency = { at: -1, value: 0 };
    this._off = { v: 0, t: 0 };
    this.grabbed = false; // a finger is holding the record (platter or zoom waveform)
    this._shown = 0; // position the display follows while grabbed: the finger's, with no latency

    this.node = new AudioWorkletNode(ctx, 'deck-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => this._onMessage(e.data);
    this.node.onprocessorerror = () => this._emit('error', { message: `Deck ${id} audio processor failed` });

    // worklet -> EQ (low, mid, high) -> channel volume -> crossfader gain -> master bus
    this.eq = {};
    let prev = this.node;
    for (const [band, cfg] of Object.entries(EQ_BANDS)) {
      const f = ctx.createBiquadFilter();
      f.type = cfg.type;
      f.frequency.value = cfg.frequency;
      if (cfg.Q) f.Q.value = cfg.Q;
      f.gain.value = 0;
      prev.connect(f);
      prev = f;
      this.eq[band] = f;
    }
    // DJ filter: low-pass then high-pass, both always in the path. At the centre the low-pass sits at
    // Nyquist and the high-pass at 5 Hz, which is transparent (see filter-math.js).
    this.filterLp = ctx.createBiquadFilter();
    this.filterLp.type = 'lowpass';
    this.filterLp.frequency.value = ctx.sampleRate ? ctx.sampleRate / 2 : 22050;
    this.filterHp = ctx.createBiquadFilter();
    this.filterHp.type = 'highpass';
    this.filterHp.frequency.value = 5;
    this.filterLp.Q.value = Q_FLAT; // dB for these filter types: -3.01 = Butterworth flat
    this.filterHp.Q.value = Q_FLAT;
    this.filterPos = 0.5;
    prev.connect(this.filterLp);
    this.filterLp.connect(this.filterHp);
    prev = this.filterHp;

    this.volume = ctx.createGain();
    this.crossfade = ctx.createGain();
    prev.connect(this.volume);
    this.volume.connect(this.crossfade);
    this.crossfade.connect(destination);

    // PFL: pre-fader, pre-crossfader send into the headphone cue bus (silent until switched on).
    this.cueSend = ctx.createGain();
    this.cueSend.gain.value = 0;
    prev.connect(this.cueSend);
    if (cueDestination) this.cueSend.connect(cueDestination);
  }

  // ---- mixer controls -------------------------------------------------------------------

  /** band: 'low'|'mid'|'high', position 0..1 (see eqPositionToDb). */
  setEq(band, position) {
    this.eq[band]?.gain.setTargetAtTime(eqPositionToDb(position), this.ctx.currentTime, SMOOTH);
  }

  /** Channel fader position 0..1. */
  setVolume(position) {
    this.volume.gain.setTargetAtTime(faderToGain(position), this.ctx.currentTime, SMOOTH);
  }

  /**
   * DJ filter knob, position 0..1 (0.5 = off, left = low-pass, right = high-pass). Cutoff and resonance
   * glide with a short time constant, so dragging the knob never zippers.
   */
  setFilter(position) {
    this.filterPos = Number.isFinite(position) ? clamp(position, 0, 1) : 0.5;
    const f = filterParams(this.filterPos, this.ctx.sampleRate ? this.ctx.sampleRate / 2 : 22050);
    const t = this.ctx.currentTime;
    this.filterLp.frequency.setTargetAtTime(f.lpHz, t, FILTER_SMOOTH);
    this.filterLp.Q.setTargetAtTime(f.lpQ, t, FILTER_SMOOTH);
    this.filterHp.frequency.setTargetAtTime(f.hpHz, t, FILTER_SMOOTH);
    this.filterHp.Q.setTargetAtTime(f.hpQ, t, FILTER_SMOOTH);
  }

  /** Headphone cue (pre-fader listen) on/off for this deck. Only audible when the engine's split cue is on. */
  setPfl(on) {
    this.pfl = !!on;
    this.cueSend.gain.setTargetAtTime(this.pfl ? 1 : 0, this.ctx.currentTime, SMOOTH);
  }

  /** Crossfader contribution for this deck, linear gain 0..1. */
  setCrossfadeGain(g) {
    this.crossfade.gain.setTargetAtTime(clamp(g, 0, 1), this.ctx.currentTime, SMOOTH);
  }

  // ---- state ----------------------------------------------------------------------------

  get loaded() {
    return this.track !== null;
  }

  get duration() {
    return this.track ? this.track.duration : 0;
  }

  /** True while the playhead is (or may be) moving: drives the shared redraw loop. */
  get moving() {
    return this.playing || this.grabbed || (this._report !== null && this._report.speed !== 0);
  }

  /** Position to draw: the finger's while grabbed (the marker stays under it), the heard position otherwise. */
  get displayPosition() {
    return this.grabbed ? this._shown : this.heardPosition;
  }

  /** Engine position in seconds, interpolated between worklet reports. */
  get position() {
    return this._estimate(this.ctx.currentTime);
  }

  /**
   * Position at context time `t`, extrapolated linearly from the last worklet report and made loop-aware
   * in the two ways a loop can break a linear extrapolation:
   *  1. A wrap that already happened (the report carries its context time and length): a time EARLIER than
   *     the wrap (what the listener still hears, one output latency behind) was on the previous repeat, so
   *     add the wrap length once per wrap (more than one when the loop is shorter than the latency).
   *     Entering a loop is NOT a wrap, so playing from the loop start is not shifted at all.
   *  2. A wrap that has happened but is not reported yet (reports come every ~21 ms): the report is inside
   *     the loop and the estimate ran past its end (or before its start in reverse): fold it back in.
   */
  _estimate(t) {
    const r = this._report;
    let p = estimatePosition(r, t, this.duration);
    if (r && r.wrap >= 0 && r.wrapLen > 0 && r.speed && t < r.wrap) {
      const period = r.wrapLen / Math.abs(r.speed); // time between wraps (the report's speed)
      p += Math.sign(r.speed) * (1 + Math.floor((r.wrap - t) / period)) * r.wrapLen;
    }
    const loop = this.loop;
    if (loop && r && inLoop(r.pos, loop) && !inLoop(p, loop) && ((r.speed > 0 && p >= loop.end) || (r.speed < 0 && p < loop.start))) {
      p = wrapIntoLoop(p, loop);
    }
    return p;
  }

  /** Output latency in seconds (what the listener hears is this far behind the engine). */
  get outputLatency() {
    const now = this.ctx.currentTime;
    if (now - this._latency.at > 1) {
      let v = 0;
      try {
        if (this.ctx.outputLatency > 0) v = this.ctx.outputLatency;
        else if (typeof this.ctx.getOutputTimestamp === 'function') {
          const ts = this.ctx.getOutputTimestamp();
          if (ts && ts.contextTime > 0) v = now - ts.contextTime;
        }
        if (!(v > 0)) v = this.ctx.baseLatency || 0;
      } catch {
        v = 0;
      }
      this._latency = { at: now, value: clamp(v, 0, 0.5) };
    }
    return this._latency.value;
  }

  _heardBase() {
    return this._estimate(this.ctx.currentTime - this.outputLatency);
  }

  /**
   * Position the listener is hearing right now: what the waveform playhead should show.
   * The engine position leads what is heard by the output latency. When play/pause/pitch rebases
   * the report, that lead appears or disappears; _off absorbs the difference and decays away, so
   * this value never jumps (only a seek moves it instantly).
   */
  get heardPosition() {
    const now = this.ctx.currentTime;
    const off = this._off.v * Math.exp(-(now - this._off.t) / (this._off.tau || OFFSET_DECAY));
    let h = clamp(this._heardBase() + off, 0, this.duration);
    // While the engine is inside the loop, what is heard is inside it too, except for the first output-latency
    // after ENTERING it (playing from the loop start, or jumping to it): the audio before the entry is a gap in
    // the loop's own timeline, so hold the playhead on the nearest loop edge instead of showing it outside.
    const loop = this.loop;
    if (loop && this._report && inLoop(this._report.pos, loop) && !inLoop(h, loop)) {
      h = Math.min(Math.max(h, loop.start), loop.end - 1e-6);
    }
    return h;
  }

  get rate() {
    return pitchToRate(this.pitch) * (1 + this._bend * BEND_AMOUNT);
  }

  /** Base BPM x pitch, or null when the grid is unknown. */
  get effectiveBpm() {
    return this.grid ? effectiveBpm(this.grid.bpm, this.pitch) : null;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _post(msg, transfer) {
    this.node.port.postMessage(msg, transfer || []);
  }

  /** Re-anchor the position report at the current engine position with a new speed, keeping the heard position continuous. */
  _rebase(speed) {
    const before = this.heardPosition;
    const r = this._report;
    // the wrap history carries over (heard times before the last wrap are still on the previous repeat)
    this._report = { pos: this.position, ctxTime: this.ctx.currentTime, speed, wrap: r ? r.wrap : -1, wrapLen: r ? r.wrapLen : 0 };
    this._off = { v: before - this._heardBase(), t: this.ctx.currentTime };
  }

  _onMessage(m) {
    if (m.type === 'pos') {
      this._report = { pos: m.pos, ctxTime: m.ctxTime, speed: m.speed, wrap: Number.isFinite(m.wrap) ? m.wrap : -1, wrapLen: Number.isFinite(m.wrapLen) ? m.wrapLen : 0 };
    } else if (m.type === 'ended') {
      this.playing = false;
      this.previewing = false;
      this._report = { pos: m.pos, ctxTime: this.ctx.currentTime, speed: 0 };
      this._emit('playstate', { playing: false });
      this._emit('ended', { edge: m.edge });
    } else if (m.type === 'loop' && m.on === false) {
      // the worklet dropped the loop: a seek or a scratch release landed outside it
      if (this.loop) {
        this.loop = null;
        this._emit('loop', { loop: null, reason: m.reason || 'dropped' });
      }
    }
  }

  // ---- loading --------------------------------------------------------------------------

  /**
   * Decode a Blob/File and hand the samples to the worklet (transferred, not copied).
   * @param {Blob} blob
   * @param {{name:string, libraryId?:string}} meta
   * @param {{beforeTransfer?:(channels:{left:Float32Array,right:Float32Array|null,sampleRate:number,length:number,duration:number}, ctl:{isCurrent:()=>boolean})=>Promise<any>}} [hooks]
   *        beforeTransfer runs on the copied channel data just before it is moved to the worklet
   *        (peaks / BPM input); it must not keep references to the arrays. Its result is returned
   *        as `prepared`; a null result means the work was aborted.
   * @returns {Promise<{ok:true, duration:number, prepared:any}|{ok:false, superseded?:true, message?:string}>}
   */
  loadBlob(blob, meta, hooks = {}) {
    return this.loadChannels(
      async (isCurrent) => {
        const bytes = await blob.arrayBuffer();
        let audio = await decode(this.ctx, bytes);
        if (!isCurrent()) return null;
        if (!audio.length || !audio.numberOfChannels) throw new Error('The file contains no audio');

        // AudioBuffer storage cannot be transferred, so copy out once and drop the AudioBuffer.
        const length = audio.length;
        const sampleRate = audio.sampleRate;
        const duration = audio.duration;
        const left = new Float32Array(length);
        audio.copyFromChannel(left, 0);
        let right = null;
        if (audio.numberOfChannels > 1) {
          right = new Float32Array(length);
          audio.copyFromChannel(right, 1);
        }
        audio = null;
        return { left, right, sampleRate, length, duration };
      },
      meta,
      { ...hooks, label: hooks.label || 'Decoding…' },
    );
  }

  /**
   * Load a track from a producer instead of a file: `produce(isCurrent)` resolves
   * {left, right|null, sampleRate, length, duration} (arrays the deck may take ownership of) or null
   * when superseded. Used for the built-in demos; loadBlob is a producer that decodes a file.
   * Same hooks and result as loadBlob; `hooks.label` is what the deck title shows meanwhile.
   */
  async loadChannels(produce, meta, hooks = {}) {
    const token = ++this._loadToken;
    const isCurrent = () => token === this._loadToken;
    this.loading = true;
    this.loadingLabel = hooks.label || 'Loading…';
    this._emit('loading', { loading: true, name: meta.name });
    try {
      const ch = await produce(isCurrent);
      if (!ch || !isCurrent()) return { ok: false, superseded: true };
      const { left, right, sampleRate, length, duration } = ch;

      const prepared = hooks.beforeTransfer ? await hooks.beforeTransfer({ left, right, sampleRate, length, duration }, { isCurrent }) : null;
      if (!isCurrent() || (hooks.beforeTransfer && prepared === null)) return { ok: false, superseded: true };

      const track = { name: meta.name, libraryId: meta.libraryId ?? null, duration, sampleRate, length };
      this.scratchEnd('load', false); // the worklet drops its own scratch state when it swaps buffers
      this._post({ type: 'load', left, right, sampleRate }, right ? [left.buffer, right.buffer] : [left.buffer]);
      this.track = track;
      this.playing = false;
      this.previewing = false;
      this.cue = 0;
      this.grid = null;
      this.analyzing = false;
      this.hotCues = new Array(HOT_CUE_COUNT).fill(null); // the app restores the stored ones via setHotCues
      this.loop = null; // the worklet dropped its loop with the old buffer
      this._report = { pos: 0, ctxTime: this.ctx.currentTime, speed: 0 };
      this._off = { v: 0, t: this.ctx.currentTime };
      this._post({ type: 'rate', value: this.rate });
      this._emit('track', { track });
      this._emit('playstate', { playing: false });
      this._emit('cue', { cue: 0 });
      this._emit('hotcues', { hotCues: this.hotCues, persist: false });
      this._emit('loop', { loop: null, reason: 'load' });
      this._emit('grid', { grid: null, persist: false });
      return { ok: true, duration, prepared };
    } catch (err) {
      if (!isCurrent()) return { ok: false, superseded: true };
      const message = (err && err.message) || 'unsupported or corrupt audio file';
      this._emit('error', { message });
      return { ok: false, message };
    } finally {
      if (isCurrent()) {
        this.loading = false;
        this._emit('loading', { loading: false });
      }
    }
  }

  // ---- transport ------------------------------------------------------------------------

  play() {
    if (!this.track || this.playing) return;
    this.playing = true;
    if (!this.grabbed) this._rebase(this.rate);
    this._post({ type: 'play' });
    this._emit('playstate', { playing: true });
  }

  pause() {
    if (!this.track || !this.playing) return;
    this.playing = false;
    this.previewing = false;
    if (!this.grabbed) this._rebase(0);
    this._post({ type: 'pause' });
    this._emit('playstate', { playing: false });
  }

  togglePlay() {
    if (!this.track) return;
    if (this.previewing) {
      this.previewing = false; // pressing PLAY while previewing latches playback
      return;
    }
    if (this.playing) this.pause();
    else this.play();
  }

  seek(seconds) {
    if (!this.track || this.grabbed || !Number.isFinite(seconds)) return; // the hand wins
    const t = clamp(seconds, 0, this.duration);
    this._report = { pos: t, ctxTime: this.ctx.currentTime, speed: this.playing ? this.rate : 0 };
    this._off = { v: 0, t: this.ctx.currentTime }; // a seek is meant to jump
    this._post({ type: 'seek', time: t });
    // A jump outside the loop ends it (the worklet does the same; this keeps the display in step).
    if (this.loop && !inLoop(t, this.loop)) {
      this.loop = null;
      this._emit('loop', { loop: null, reason: 'seek' });
    }
  }

  // ---- hot cues -------------------------------------------------------------------------

  /**
   * Replace all hot cues (restoring from the library). persist=false: do not write them back.
   * @param {(number|null)[]} cues
   */
  setHotCues(cues, { persist = false } = {}) {
    this.hotCues = sanitizeHotCues(cues, this.duration || Infinity);
    this._emit('hotcues', { hotCues: this.hotCues, persist });
  }

  /**
   * Set hot cue `i` at the heard position, snapped to the nearest beat when the grid is confident.
   * Returns the time it was set at, or null (no track / bad index).
   */
  setHotCue(i) {
    if (!this.track || !(i >= 0 && i < HOT_CUE_COUNT)) return null;
    const t = hotCueTime(this.heardPosition, this.grid, this.duration);
    const next = this.hotCues.slice();
    next[i] = t;
    this.hotCues = next;
    this._emit('hotcues', { hotCues: this.hotCues, persist: true });
    return t;
  }

  /** Remove hot cue `i`. */
  clearHotCue(i) {
    if (!this.track || !(i >= 0 && i < HOT_CUE_COUNT) || this.hotCues[i] === null) return;
    const next = this.hotCues.slice();
    next[i] = null;
    this.hotCues = next;
    this._emit('hotcues', { hotCues: this.hotCues, persist: true });
  }

  /**
   * Jump to hot cue `i`: playing, the deck keeps playing from there; paused, it jumps and stays paused
   * (like a CDJ). Ignored while a finger holds the record. Returns whether it jumped.
   */
  jumpHotCue(i) {
    const t = this.hotCues[i];
    if (!this.track || this.grabbed || t === null || t === undefined) return false;
    this.seek(t);
    return true;
  }

  // ---- loops ----------------------------------------------------------------------------

  /**
   * Auto-loop of `beats` beats from the beat at or before the heard position; the same size again exits;
   * another size while looping keeps the in-point. Needs a beat grid.
   * @returns {{ok:true, action:'set'|'exit', loop?:object}|{ok:false, reason:string}}
   */
  autoLoop(beats) {
    if (!this.track) return { ok: false, reason: 'bad' };
    const plan = planLoop({ pos: this.heardPosition, grid: this.grid, beats, duration: this.duration, active: this.loop });
    if (!plan.ok) return plan;
    if (plan.action === 'exit') {
      this.exitLoop();
      return plan;
    }
    this.loop = { start: plan.start, end: plan.end, beats: plan.beats };
    this._post({ type: 'loop', on: true, start: plan.start, end: plan.end });
    this._emit('loop', { loop: this.loop, reason: 'set' });
    return { ok: true, action: 'set', loop: this.loop };
  }

  /** Leave the loop; playback carries on past its end without a break. */
  exitLoop() {
    if (!this.loop) return;
    this.loop = null;
    this._post({ type: 'loop', on: false });
    this._emit('loop', { loop: null, reason: 'exit' });
  }

  // ---- scratch --------------------------------------------------------------------------

  /** A finger lands on the record: it stops under the finger. Returns false when there is nothing to grab. */
  scratchBegin() {
    if (!this.track || this.grabbed) return false;
    this.grabbed = true;
    // Grab at the position the listener hears (the engine runs ahead by the output latency), so the
    // display, the finger and the audio agree from the first touch.
    this._shown = this.heardPosition;
    this._post({ type: 'scratch', delta: 0, at: this._shown, t: performance.now() / 1000 });
    this._emit('grab', { grabbed: true, reason: 'grab' });
    return true;
  }

  /**
   * The finger moved the record by `seconds` of track time (forward positive).
   * @param {number} seconds
   * @param {number} [timeStamp] the pointer event's timeStamp (performance.now() domain)
   */
  scratchBy(seconds, timeStamp) {
    if (!this.grabbed || !Number.isFinite(seconds) || seconds === 0) return;
    this._shown = applyDelta(this._shown, seconds, 0, this.duration);
    // Pointer event time in seconds on the performance clock; the worklet only uses differences between events.
    const t = (Number.isFinite(timeStamp) && timeStamp > 0 ? timeStamp : performance.now()) / 1000;
    this._post({ type: 'scratch', delta: seconds, t });
  }

  /**
   * The finger lifted (or the grab was lost). Playing: the motor spins the record back up to the pitch
   * rate; paused: it stays where the finger left it. Safe to call when not grabbed.
   */
  scratchEnd(reason = 'release', post = true) {
    if (!this.grabbed) return;
    const shown = this._shown;
    this.grabbed = false;
    if (post) {
      this._post({ type: 'scratch', target: null });
      // The display followed the finger; it now returns to the heard position. After a fast flick those
      // differ by (scratch lag + output latency) x speed, which would jump the waveform: ease it out over
      // ~70 ms. A normal release (finger at rest) has no gap and gets no slide.
      const gap = shown - this._heardBase();
      if (Math.abs(gap) > RELEASE_GAP && Number.isFinite(gap)) this._off = { v: gap, t: this.ctx.currentTime, tau: RELEASE_EASE };
    }
    this._emit('grab', { grabbed: false, reason });
  }

  // ---- pitch / tempo ----------------------------------------------------------------------

  _applyRate() {
    this._post({ type: 'rate', value: this.rate });
    if (this.playing && !this.grabbed) this._rebase(this.rate);
  }

  /** Pitch in percent (+8 = 8 % faster), limited to the current range. */
  setPitch(percent) {
    if (!Number.isFinite(percent)) return;
    this.pitch = clamp(percent, -this.pitchRange, this.pitchRange);
    this._applyRate();
    this._emit('pitch', { pitch: this.pitch, range: this.pitchRange });
  }

  /** Per-deck range (8 or 16 %). Narrowing below the current pitch is refused (returns false): clamping would jump the audio. */
  setPitchRange(range) {
    const r = range === 16 ? 16 : 8;
    if (Math.abs(this.pitch) > r + 1e-9) return false;
    this.pitchRange = r;
    this._emit('pitch', { pitch: this.pitch, range: this.pitchRange });
    return true;
  }

  /** Hold-to-bend: direction -1 (slower), +1 (faster), 0 (release). */
  setBend(direction) {
    this._bend = direction > 0 ? 1 : direction < 0 ? -1 : 0;
    this._applyRate();
  }

  /**
   * Replace the beat grid. persist=true asks the app to store it in the library.
   * @param {{bpm:number, offset:number, confidence?:number, source?:string}|null} grid
   */
  setGrid(grid, { persist = true } = {}) {
    if (grid && !(Number.isFinite(grid.bpm) && grid.bpm > 0 && Number.isFinite(grid.offset))) return;
    this.grid = grid ? { confidence: 1, source: 'manual', ...grid } : null;
    this._emit('grid', { grid: this.grid, persist });
  }

  // ---- cue ------------------------------------------------------------------------------

  /**
   * CUE pressed.
   *  - playing: jump to the cue point and pause.
   *  - paused at the cue point: preview-play for as long as the button is held.
   *  - paused elsewhere: set the cue point here.
   */
  cuePress() {
    if (!this.track || this.grabbed) return; // the hand wins
    if (this.playing) {
      this.pause();
      this.seek(this.cue);
      return;
    }
    const pos = this.position;
    if (isNear(pos, this.cue)) {
      this.previewing = true;
      this.play();
    } else {
      this.cue = pos;
      this._emit('cue', { cue: pos });
    }
  }

  /** CUE released: end a preview by returning to the cue point (unless PLAY latched it). */
  cueRelease() {
    if (!this.previewing) return;
    this.previewing = false;
    this.pause();
    this.seek(this.cue);
  }
}
