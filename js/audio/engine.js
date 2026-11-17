// Audio engine: one lazily created AudioContext, user-gesture unlock, master chain, decks.
//
// Graph (per deck):  worklet -> EQ -> filter (LP, HP) -> volume -> crossfade gain -> master gain
//                                                          \-> PFL send -> cue bus
//
// Output stage. Both paths below are always connected; a pair of mode gains crossfades between them
// (20 ms), so turning split cue on or off never clicks and never interrupts playback:
//
//   normal : master gain -> limiter (stereo) ---------------------------------> normal gain --\
//   split  : master gain -> mono -> (x mix) -+-> left bus -> limiter L ->|merger ch0|            \
//            cue bus gain -> mono -> (x 1-mix)/                                   |-> split gain --> destination
//            master mono ---------------------> right bus -> limiter R ->|merger ch1|            /
//
// Split cue is for a Y-split headphone cable: left ear = cue/master mix, right ear = master, both mono
// and both summed AFTER their own gain stages. Each ear has its own limiter, so a loud cue never ducks the
// master ear and neither side can clip.
//
// Events (EventTarget): 'running' (context is producing audio), 'blocked' (context is
// suspended/interrupted and needs a user gesture), 'statechange' {state}.

import { Deck } from './deck.js';
import { crossfaderGains, faderToGain, FADER_UNITY } from './mixer-math.js';

const PROCESSOR_URL = new URL('./deck-processor.js', import.meta.url).href;
const SMOOTH = 0.012;
const MODE_SMOOTH = 0.006; // mode crossfade time constant (about 20 ms to settle)

function makeLimiter(ctx) {
  const lim = ctx.createDynamicsCompressor();
  lim.threshold.value = -2;
  lim.knee.value = 0;
  lim.ratio.value = 20;
  lim.attack.value = 0.002;
  lim.release.value = 0.12;
  return lim;
}

/** A gain node that sums whatever reaches it down to one channel ((L + R) / 2). */
function makeMono(ctx) {
  const g = ctx.createGain();
  try {
    g.channelCount = 1;
    g.channelCountMode = 'explicit';
    g.channelInterpretation = 'speakers';
  } catch {
    /* an implementation that refuses keeps its stereo sum: still correct once merged */
  }
  return g;
}

/**
 * Make the destination carry exactly the channels the device has (1 or 2). Some mobile browsers report a
 * mono destination (maxChannelCount 1) and throw IndexSizeError on channelCount 2, so every step is
 * guarded and the result says what we ended up with.
 * @returns {{channels:number, max:number}}
 */
export function configureDestination(ctx) {
  const dest = ctx.destination;
  const max = Number.isFinite(dest.maxChannelCount) && dest.maxChannelCount > 0 ? dest.maxChannelCount : 2;
  const want = Math.min(2, max);
  try {
    if (dest.channelCount !== want) dest.channelCount = want;
  } catch {
    /* keep the browser's default */
  }
  try {
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'speakers';
  } catch {
    /* fixed on some browsers: fine */
  }
  return { channels: Number.isFinite(dest.channelCount) ? dest.channelCount : want, max };
}

export function detectSupport() {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return { ok: false, reason: 'This browser has no Web Audio support. Try a recent Safari, Chrome or Firefox.' };
  if (typeof globalThis.AudioWorkletNode === 'undefined') {
    const insecure = globalThis.isSecureContext === false;
    return {
      ok: false,
      reason: insecure
        ? 'AudioWorklet needs a secure page. Open this app over https or on localhost (run "node tools/serve.mjs --https" and use the https address).'
        : 'This browser does not support AudioWorklet, which the decks need. Update your browser (iOS 14.5+ / Chrome 66+ / Firefox 76+).',
    };
  }
  return { ok: true, AC };
}

export class Engine extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.decks = {};
    this.master = null;
    this.limiter = null;
    this._starting = null;
    this._crossfader = 0.5;
    this._masterPosition = FADER_UNITY;
    this.splitCue = false; // headphone split-mono cue on (applied once the graph exists)
    this.cueMix = 0.5; // 0 = left ear all cue, 1 = left ear all master
    this.destination = { channels: 2, max: 2 };
  }

  /** The output can carry a separate left and right ear (false on a mono device). */
  get splitSupported() {
    return this.destination.max >= 2 && this.destination.channels >= 2;
  }

  get state() {
    return this.ctx ? this.ctx.state : 'idle';
  }

  /**
   * Create (first call) and unlock the context. Must be called from a user gesture.
   * Never throws. Resolves {ok:true} or {ok:false, reason, unsupported?}.
   */
  start() {
    if (this._starting) return this._starting;
    if (this.ctx) return this.ensureRunning().then((ok) => (ok ? { ok: true } : { ok: false, reason: 'Audio is still blocked. Tap again.' }));
    this._starting = this._init()
      .catch((err) => ({ ok: false, reason: `Audio failed to start: ${(err && err.message) || err}` }))
      .then((res) => {
        if (!res.ok) this._teardown();
        this._starting = null;
        return res;
      });
    return this._starting;
  }

  async _init() {
    const support = detectSupport();
    if (!support.ok) return { ok: false, reason: support.reason, unsupported: true };

    let ctx;
    try {
      ctx = new support.AC({ latencyHint: 'interactive' });
    } catch {
      ctx = new support.AC();
    }
    this.ctx = ctx;
    // Kick off resume synchronously inside the gesture; iOS requires this before any await.
    const resumed = ctx.resume().catch(() => {});
    this._playUnlockTone(ctx);

    if (!ctx.audioWorklet) {
      return { ok: false, reason: 'AudioWorklet is unavailable on this page. Use https or localhost.', unsupported: true };
    }
    await ctx.audioWorklet.addModule(PROCESSOR_URL);

    this.destination = configureDestination(ctx);
    this._buildOutput(ctx);

    for (const id of ['A', 'B']) this.decks[id] = new Deck(ctx, id, this.master, this.cueBus);
    this._applyCrossfader();
    this._applyCue(true);

    ctx.addEventListener('statechange', () => this._onStateChange());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.ensureRunning();
    });
    // Any touch/key is a user gesture: use it to recover from suspended/interrupted.
    for (const type of ['pointerdown', 'touchend', 'keydown']) {
      document.addEventListener(type, () => this._gestureResume(), { capture: true, passive: true });
    }

    await resumed;
    await this.ensureRunning();
    return { ok: true };
  }

  _buildOutput(ctx) {
    this.master = ctx.createGain();
    this.master.gain.value = faderToGain(this._masterPosition);

    // normal path: master -> limiter -> normal gain -> destination
    this.limiter = makeLimiter(ctx);
    this.normalGain = ctx.createGain();
    this.master.connect(this.limiter);
    this.limiter.connect(this.normalGain);
    this.normalGain.connect(ctx.destination);

    // split path: cue bus and master, each summed to mono after its own gain
    this.cueBus = ctx.createGain();
    const cueMono = makeMono(ctx);
    const masterMono = makeMono(ctx);
    this.cueToLeft = ctx.createGain();
    this.masterToLeft = ctx.createGain();
    const leftBus = ctx.createGain();
    const rightBus = ctx.createGain();
    this.limiterL = makeLimiter(ctx);
    this.limiterR = makeLimiter(ctx);
    const merger = ctx.createChannelMerger(2);
    this.splitGain = ctx.createGain();
    this.cueBus.connect(cueMono);
    this.master.connect(masterMono);
    cueMono.connect(this.cueToLeft);
    masterMono.connect(this.masterToLeft);
    this.cueToLeft.connect(leftBus);
    this.masterToLeft.connect(leftBus);
    masterMono.connect(rightBus);
    leftBus.connect(this.limiterL);
    rightBus.connect(this.limiterR);
    this.limiterL.connect(merger, 0, 0);
    this.limiterR.connect(merger, 0, 1);
    merger.connect(this.splitGain);
    this.splitGain.connect(ctx.destination);

    this.normalGain.gain.value = this.splitCue ? 0 : 1;
    this.splitGain.gain.value = this.splitCue ? 1 : 0;
  }

  _teardown() {
    const ctx = this.ctx;
    this.ctx = null;
    this.decks = {};
    this.master = this.limiter = null;
    this.cueBus = this.normalGain = this.splitGain = null;
    if (ctx && ctx.state !== 'closed') ctx.close().catch(() => {});
  }

  // A one-frame silent buffer played in the gesture: the classic iOS unlock.
  _playUnlockTone(ctx) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* non-fatal */
    }
  }

  _gestureResume() {
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') this.ctx.resume().catch(() => {});
  }

  _onStateChange() {
    const state = this.ctx.state;
    this.dispatchEvent(new CustomEvent('statechange', { detail: { state } }));
    if (state === 'running') this.dispatchEvent(new Event('running'));
    else if (state !== 'closed') this.ensureRunning();
  }

  /** Try to resume; emits 'blocked' if the browser still refuses (needs a gesture). */
  async ensureRunning() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return false;
    if (ctx.state !== 'running') {
      // resume() can stay pending forever while interrupted, so do not wait on it indefinitely.
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 600))]);
    }
    if (ctx.state === 'running') {
      this.dispatchEvent(new Event('running'));
      return true;
    }
    this.dispatchEvent(new Event('blocked'));
    return false;
  }

  // ---- mixer ----------------------------------------------------------------------------

  /** Crossfader position 0 (deck A) .. 1 (deck B), equal-power. */
  setCrossfader(x) {
    this._crossfader = x;
    this._applyCrossfader();
  }

  _applyCrossfader() {
    const { a, b } = crossfaderGains(this._crossfader);
    this.decks.A?.setCrossfadeGain(a);
    this.decks.B?.setCrossfadeGain(b);
  }

  /**
   * Split-mono headphone cue on/off. Refused (returns false, stays off) when the output has only one
   * channel. Crossfades between the two output paths over ~20 ms: no click, playback never stops.
   */
  setSplitCue(on) {
    const want = !!on;
    if (want && this.ctx && !this.splitSupported) return false;
    this.splitCue = want;
    this._applyCue(false);
    return true;
  }

  /** Left ear balance: 0 = all cue, 1 = all master (equal-power). */
  setCueMix(m) {
    this.cueMix = Number.isFinite(m) ? Math.min(1, Math.max(0, m)) : 0.5;
    this._applyCue(false);
  }

  _applyCue(immediate) {
    if (!this.ctx || !this.cueToLeft) return;
    const t = this.ctx.currentTime;
    const { a, b } = crossfaderGains(this.cueMix); // a = cue, b = master
    this.cueToLeft.gain.setTargetAtTime(a, t, SMOOTH);
    this.masterToLeft.gain.setTargetAtTime(b, t, SMOOTH);
    const split = this.splitCue && this.splitSupported;
    if (immediate) {
      this.normalGain.gain.value = split ? 0 : 1;
      this.splitGain.gain.value = split ? 1 : 0;
      return;
    }
    this.normalGain.gain.setTargetAtTime(split ? 0 : 1, t, MODE_SMOOTH);
    this.splitGain.gain.setTargetAtTime(split ? 1 : 0, t, MODE_SMOOTH);
  }

  /** Master fader position 0..1. */
  setMaster(position) {
    this._masterPosition = position;
    this.master?.gain.setTargetAtTime(faderToGain(position), this.ctx.currentTime, SMOOTH);
  }
}
