// Canvas waveform renderers: whole-track overview (tap/drag to seek) and the zoomed,
// centre-locked scrolling view with beat grid.
//
// Performance rules: layout is read only on resize (fit), colours are cached, the static overview
// bitmap is cached in an offscreen canvas, and the shared frame loop only calls draw() when the
// playhead moved or something changed.

import { PEAK_BASE, getColumns } from '../audio/peaks.js';
import { beatsInRange } from '../audio/sync-math.js';

export const ZOOM_SECONDS = 8;
const MAX_DPR = 3;
const SEEK_THROTTLE_MS = 40;

class Surface {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.peaks = null;
    this.needsFit = true;
    this.dirty = true;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.colors = { accent: '#38d4ff', well: '#0e0f10', cue: '#ffb62e' };
    this.min = new Float32Array(0);
    this.max = new Float32Array(0);
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => {
        this.needsFit = true;
      });
      this.ro.observe(canvas);
    } else {
      for (const t of ['resize', 'orientationchange']) {
        window.addEventListener(t, () => {
          this.needsFit = true;
        });
      }
    }
  }

  setPeaks(peaks) {
    this.peaks = peaks;
    this.dirty = true;
    this.onPeaksChanged?.();
  }

  /** True once after a resize / peaks change; the caller then redraws. */
  takeDirty() {
    const d = this.dirty || this.needsFit;
    this.dirty = false;
    return d;
  }

  /** Read layout and colours. Only called after a resize, never per frame. Returns false if nothing to draw on. */
  fit() {
    if (!this.needsFit) return this.w > 0 && this.h > 0;
    this.needsFit = false;
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    if (!(r.width > 0) || !(r.height > 0)) {
      this.w = this.h = 0;
      return false;
    }
    this.w = r.width;
    this.h = r.height;
    this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    const cs = getComputedStyle(this.canvas);
    this.colors = {
      accent: cs.getPropertyValue('--accent').trim() || this.colors.accent,
      well: cs.getPropertyValue('--well').trim() || this.colors.well,
      cue: cs.getPropertyValue('--cue').trim() || this.colors.cue,
    };
    const cols = Math.ceil(r.width) + 3;
    if (this.min.length < cols) {
      this.min = new Float32Array(cols);
      this.max = new Float32Array(cols);
    }
    this.onFit?.();
    return true;
  }

  /** Fill min/max column bars into `ctx`. x0 is the left edge, `shift` a sub-pixel translation. */
  bars(ctx, cols, mid, amp, shift) {
    const { min, max } = this;
    for (let x = 0; x < cols; x++) {
      const top = mid - Math.min(1, max[x]) * amp;
      const bottom = mid - Math.max(-1, min[x]) * amp;
      ctx.fillRect(x - shift, top, 1, Math.max(1, bottom - top));
    }
  }
}

export class Overview extends Surface {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{hit:HTMLElement, onSeek:(fraction:number)=>void}} o  hit: element that receives the pointer
   *        events (larger than the visible strip so it is easy to hit)
   */
  constructor(canvas, { hit, onSeek }) {
    super(canvas);
    this.cache = null;
    this.cacheDirty = true;
    let activeId = null;
    let lastSent = 0;
    let lastFrac = null;
    const frac = (e) => {
      const r = canvas.getBoundingClientRect();
      if (!(r.width > 0)) return null;
      const f = (e.clientX - r.left) / r.width;
      return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : null;
    };
    hit.addEventListener('pointerdown', (e) => {
      if (activeId !== null) return;
      const f = frac(e);
      if (f === null) return;
      e.preventDefault();
      activeId = e.pointerId;
      hit.setPointerCapture(e.pointerId);
      lastSent = performance.now();
      lastFrac = f;
      onSeek(f);
    });
    hit.addEventListener('pointermove', (e) => {
      if (e.pointerId !== activeId) return;
      const f = frac(e);
      if (f === null) return;
      lastFrac = f;
      const now = performance.now();
      if (now - lastSent < SEEK_THROTTLE_MS) return;
      lastSent = now;
      onSeek(f);
    });
    // Always finish with a seek to where the finger actually ended.
    hit.addEventListener('pointerup', (e) => {
      if (e.pointerId !== activeId) return;
      const f = frac(e);
      activeId = null;
      onSeek(f === null ? lastFrac : f);
    });
    for (const t of ['pointercancel', 'lostpointercapture']) {
      hit.addEventListener(t, (e) => {
        if (e.pointerId === activeId) activeId = null;
      });
    }
  }

  onPeaksChanged() {
    this.cacheDirty = true;
  }

  onFit() {
    this.cacheDirty = true;
  }

  // The waveform itself never changes between frames: render it once into an offscreen bitmap.
  _buildCache() {
    this.cacheDirty = false;
    const peaks = this.peaks;
    if (!peaks || !(this.w > 0)) {
      this.cache = null;
      return;
    }
    const c = this.cache && this.cache.width === this.canvas.width && this.cache.height === this.canvas.height ? this.cache : document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const cols = Math.floor(this.w);
    getColumns(peaks, 0, peaks.length / this.w, cols, this.min, this.max);
    g.fillStyle = this.colors.accent;
    this.bars(g, cols, this.h / 2, (this.h / 2) * 0.95, 0);
    this.cache = c;
  }

  /** @param {{pos:number, duration:number, cue:number}} s */
  draw({ pos, duration, cue }) {
    if (!this.fit()) return;
    if (this.cacheDirty) this._buildCache();
    const { ctx, w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.cache || !(duration > 0)) return;
    ctx.drawImage(this.cache, 0, 0, w, h);
    const playedX = Math.min(w, Math.max(0, (pos / duration) * w));
    ctx.globalAlpha = 0.62;
    ctx.fillStyle = this.colors.well;
    ctx.fillRect(0, 0, playedX, h);
    ctx.globalAlpha = 1;
    if (cue > 0) {
      const cx = Math.round((cue / duration) * w);
      ctx.fillStyle = this.colors.cue;
      ctx.fillRect(cx, 0, 2, h);
    }
    ctx.fillStyle = '#ece8df';
    ctx.fillRect(Math.round(playedX) - 1, 0, 2, h);
  }
}

export const GRAB_ZOOM_SECONDS = 2; // while a finger holds the record the view zooms in: a drag is ~4x finer
const ZOOM_EASE_TAU_MS = 35; // ~95 % of the way in 100 ms

// Frames per column (a whole number of level-0 buckets) for a view `w` px wide showing `seconds`.
function zoomFramesPerPixel(sampleRate, w, seconds) {
  return Math.max(1, Math.round(((seconds * sampleRate) / w) / PEAK_BASE)) * PEAK_BASE;
}

export class ZoomWave extends Surface {
  constructor(canvas) {
    super(canvas);
    this.zoomSeconds = ZOOM_SECONDS; // currently shown width, eased toward zoomTarget
    this.zoomTarget = ZOOM_SECONDS;
    this._zoomAt = 0;
  }

  /** Zoom in while a finger holds the record, back out on release (eased either way). */
  setGrabbed(on) {
    const t = on ? GRAB_ZOOM_SECONDS : ZOOM_SECONDS;
    if (t !== this.zoomTarget) {
      this.zoomTarget = t;
      this._zoomAt = performance.now();
    }
  }

  /** True while the zoom level is still easing: the caller keeps redrawing. */
  get animating() {
    return this.zoomSeconds !== this.zoomTarget;
  }

  _ease() {
    if (this.zoomSeconds === this.zoomTarget) return;
    const now = performance.now();
    const dt = Math.max(0, now - this._zoomAt);
    this._zoomAt = now;
    this.zoomSeconds += (this.zoomTarget - this.zoomSeconds) * (1 - Math.exp(-dt / ZOOM_EASE_TAU_MS));
    if (Math.abs(this.zoomTarget - this.zoomSeconds) < 0.01) this.zoomSeconds = this.zoomTarget;
  }

  /** Track seconds per CSS pixel of the zoom view as currently drawn (what a scratch drag maps pixels to), or null before layout. */
  get secondsPerPixel() {
    if (!(this.w > 0)) return null;
    const sr = this.peaks ? this.peaks.sampleRate : 0;
    return sr > 0 ? zoomFramesPerPixel(sr, this.w, this.zoomSeconds) / sr : this.zoomSeconds / this.w;
  }

  /** @param {{pos:number, duration:number, cue:number, grid:{bpm:number,offset:number}|null, grabbed?:boolean}} s */
  draw({ pos, duration, cue, grid, grabbed = false }) {
    if (!this.fit()) return;
    this._ease();
    const { ctx, w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const peaks = this.peaks;
    if (!peaks || !(duration > 0)) return;

    // One column = one CSS pixel = a whole number of level-0 buckets. The column grid is anchored to
    // multiples of framesPerPixel in the track, and the leftover fraction becomes a sub-pixel
    // translation, so bar heights never change as the track scrolls (no shimmer).
    const sr = peaks.sampleRate;
    const fpp = zoomFramesPerPixel(sr, w, this.zoomSeconds);
    const secPerPx = fpp / sr;
    const centre = w / 2;
    const leftFrame = (pos - (centre * secPerPx)) * sr;
    const first = Math.floor(leftFrame / fpp);
    const shift = leftFrame / fpp - first; // 0..1 px
    const cols = Math.ceil(w) + 2;
    getColumns(peaks, first * fpp, fpp, cols, this.min, this.max, undefined, 0);

    const split = Math.max(0, Math.min(cols, Math.round(centre + shift)));
    ctx.fillStyle = this.colors.accent;
    ctx.globalAlpha = 0.4;
    this._range(ctx, 0, split, shift);
    ctx.globalAlpha = 1;
    this._range(ctx, split, cols, shift);

    if (grid) {
      const half = centre * secPerPx;
      for (const b of beatsInRange(grid, pos - half, pos + half)) {
        if (b.time < 0 || b.time > duration) continue;
        const x = Math.round(centre + (b.time - pos) / secPerPx);
        if (b.downbeat) {
          ctx.fillStyle = 'rgba(236,232,223,0.85)';
          ctx.fillRect(x - 1, 0, 2, h);
        } else {
          ctx.fillStyle = 'rgba(236,232,223,0.38)';
          ctx.fillRect(x, h * 0.22, 1, h * 0.56);
        }
      }
    }
    const cx = Math.round(centre + (cue - pos) / secPerPx);
    if (cx >= -6 && cx <= w + 6) {
      ctx.fillStyle = this.colors.cue;
      ctx.fillRect(cx, 0, 2, h);
      ctx.beginPath();
      ctx.moveTo(cx - 5, 0);
      ctx.lineTo(cx + 7, 0);
      ctx.lineTo(cx + 1, 8);
      ctx.fill();
    }
    // Playhead: pale normally; while the record is in a hand it sits in a dark slot and takes the deck colour.
    if (grabbed) {
      ctx.fillStyle = this.colors.well;
      ctx.fillRect(Math.round(centre) - 4, 0, 8, h);
      ctx.fillStyle = this.colors.accent;
      ctx.fillRect(Math.round(centre) - 1, 0, 3, h);
    } else {
      ctx.fillStyle = '#ece8df';
      ctx.fillRect(Math.round(centre) - 1, 0, 2, h);
    }
  }

  // Draw columns [from, to) of the current min/max arrays.
  _range(ctx, from, to, shift) {
    const mid = this.h / 2;
    const amp = mid * 0.9;
    for (let x = from; x < to; x++) {
      const top = mid - Math.min(1, this.max[x]) * amp;
      const bottom = mid - Math.max(-1, this.min[x]) * amp;
      ctx.fillRect(x - shift, top, 1, Math.max(1, bottom - top));
    }
  }
}
