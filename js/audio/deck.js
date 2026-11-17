// Main-thread side of a deck: owns the AudioWorkletNode, the per-deck EQ/volume/crossfade
// nodes, decoding + transfer of track data, and transport logic (play, pause, seek, cue).
//
// Events (EventTarget): 'loading' {loading}, 'track' {track|null}, 'playstate' {playing},
// 'cue' {cue}, 'ended', 'error' {message}.

import { clamp, eqPositionToDb, faderToGain } from './mixer-math.js';
import { estimatePosition, isNear } from './playhead-math.js';

const EQ_BANDS = {
  low: { type: 'lowshelf', frequency: 250 },
  mid: { type: 'peaking', frequency: 1000, Q: 0.7 },
  high: { type: 'highshelf', frequency: 3500 },
};
const SMOOTH = 0.012; // setTargetAtTime constant for control changes

function decode(ctx, arrayBuffer) {
  // Callback form: works on every Safari, unlike promise-only decodeAudioData.
  return new Promise((resolve, reject) => ctx.decodeAudioData(arrayBuffer, resolve, reject));
}

export class Deck extends EventTarget {
  /** @param {AudioContext} ctx  @param {string} id 'A'|'B'  @param {AudioNode} destination master bus input */
  constructor(ctx, id, destination) {
    super();
    this.ctx = ctx;
    this.id = id;
    this.track = null; // { name, duration, sampleRate, length, libraryId }
    this.playing = false;
    this.previewing = false;
    this.loading = false;
    this.cue = 0;
    this.rate = 1;
    this._report = null;
    this._loadToken = 0;

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
    this.volume = ctx.createGain();
    this.crossfade = ctx.createGain();
    prev.connect(this.volume);
    this.volume.connect(this.crossfade);
    this.crossfade.connect(destination);
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

  /** Crossfader contribution for this deck, linear gain 0..1. */
  setCrossfadeGain(g) {
    this.crossfade.gain.setTargetAtTime(g, this.ctx.currentTime, SMOOTH);
  }

  // ---- state ----------------------------------------------------------------------------

  get loaded() {
    return this.track !== null;
  }

  get duration() {
    return this.track ? this.track.duration : 0;
  }

  /** Current position in seconds, interpolated between worklet reports. */
  get position() {
    return estimatePosition(this._report, this.ctx.currentTime, this.duration);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _post(msg, transfer) {
    this.node.port.postMessage(msg, transfer || []);
  }

  _rebase(speed) {
    this._report = { pos: this.position, ctxTime: this.ctx.currentTime, speed };
  }

  _onMessage(m) {
    if (m.type === 'pos') {
      this._report = { pos: m.pos, ctxTime: m.ctxTime, speed: m.speed };
    } else if (m.type === 'ended') {
      this.playing = false;
      this.previewing = false;
      this._report = { pos: m.pos, ctxTime: this.ctx.currentTime, speed: 0 };
      this._emit('playstate', { playing: false });
      this._emit('ended', { edge: m.edge });
    }
  }

  // ---- loading --------------------------------------------------------------------------

  /**
   * Decode a Blob/File and hand the samples to the worklet (transferred, not copied).
   * The previous track's buffers are released by the worklet on 'load'.
   * @param {Blob} blob
   * @param {{name:string, libraryId?:string}} meta
   * @param {{onDecoded?:(audio:AudioBuffer)=>void}} [hooks] called with the AudioBuffer before its
   *        channel data is copied out, so later milestones can compute peaks/BPM from it.
   * @returns {Promise<{ok:true, duration:number}|{ok:false, superseded?:true, message?:string}>}
   */
  async loadBlob(blob, meta, hooks = {}) {
    const token = ++this._loadToken;
    this.loading = true;
    this._emit('loading', { loading: true, name: meta.name });
    try {
      const bytes = await blob.arrayBuffer();
      const audio = await decode(this.ctx, bytes);
      if (token !== this._loadToken) return { ok: false, superseded: true };
      if (!audio.length || !audio.numberOfChannels) throw new Error('The file contains no audio');
      hooks.onDecoded?.(audio);

      // AudioBuffer storage cannot be transferred, so copy out once, then drop the AudioBuffer.
      const left = new Float32Array(audio.length);
      audio.copyFromChannel(left, 0);
      let right = null;
      if (audio.numberOfChannels > 1) {
        right = new Float32Array(audio.length);
        audio.copyFromChannel(right, 1);
      }
      const track = {
        name: meta.name,
        libraryId: meta.libraryId ?? null,
        duration: audio.duration,
        sampleRate: audio.sampleRate,
        length: audio.length,
      };
      this._post(
        { type: 'load', left, right, sampleRate: audio.sampleRate },
        right ? [left.buffer, right.buffer] : [left.buffer],
      );
      this.track = track;
      this.playing = false;
      this.previewing = false;
      this.cue = 0;
      this._report = { pos: 0, ctxTime: this.ctx.currentTime, speed: 0 };
      this._emit('track', { track });
      this._emit('playstate', { playing: false });
      this._emit('cue', { cue: 0 });
      return { ok: true, duration: track.duration };
    } catch (err) {
      if (token !== this._loadToken) return { ok: false, superseded: true };
      const message = (err && err.message) || 'unsupported or corrupt audio file';
      this._emit('error', { message });
      return { ok: false, message };
    } finally {
      if (token === this._loadToken) {
        this.loading = false;
        this._emit('loading', { loading: false });
      }
    }
  }

  // ---- transport ------------------------------------------------------------------------

  play() {
    if (!this.track || this.playing) return;
    this.playing = true;
    this._rebase(this.rate);
    this._post({ type: 'play' });
    this._emit('playstate', { playing: true });
  }

  pause() {
    if (!this.track || !this.playing) return;
    this.playing = false;
    this.previewing = false;
    this._rebase(0);
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
    if (!this.track) return;
    const t = clamp(seconds, 0, this.duration);
    this._report = { pos: t, ctxTime: this.ctx.currentTime, speed: this.playing ? this.rate : 0 };
    this._post({ type: 'seek', time: t });
  }

  /** Signed playback rate (1 = normal, negative = reverse). */
  setRate(rate) {
    this.rate = rate;
    this._post({ type: 'rate', value: rate });
    if (this.playing) this._rebase(rate);
  }

  /** Scratch hook for M3: chase `seconds`, or release with null. */
  setScratchTarget(seconds) {
    this._post({ type: 'scratch', target: seconds });
  }

  // ---- cue ------------------------------------------------------------------------------

  /**
   * CUE pressed.
   *  - playing: jump to the cue point and pause.
   *  - paused at the cue point: preview-play for as long as the button is held.
   *  - paused elsewhere: set the cue point here.
   */
  cuePress() {
    if (!this.track) return;
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
