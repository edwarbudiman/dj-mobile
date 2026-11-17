// Audio engine: one lazily created AudioContext, user-gesture unlock, master chain, decks.
//
// Graph:  deck worklet -> EQ -> volume -> crossfade gain -> master gain -> limiter -> destination
//
// Events (EventTarget): 'running' (context is producing audio), 'blocked' (context is
// suspended/interrupted and needs a user gesture), 'statechange' {state}.

import { Deck } from './deck.js';
import { crossfaderGains, faderToGain, FADER_UNITY } from './mixer-math.js';

const PROCESSOR_URL = new URL('./deck-processor.js', import.meta.url).href;
const SMOOTH = 0.012;

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

    this.master = ctx.createGain();
    this.master.gain.value = faderToGain(this._masterPosition);
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    for (const id of ['A', 'B']) this.decks[id] = new Deck(ctx, id, this.master);
    this._applyCrossfader();

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

  _teardown() {
    const ctx = this.ctx;
    this.ctx = null;
    this.decks = {};
    this.master = this.limiter = null;
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

  /** Master fader position 0..1. */
  setMaster(position) {
    this._masterPosition = position;
    this.master?.gain.setTargetAtTime(faderToGain(position), this.ctx.currentTime, SMOOTH);
  }
}
