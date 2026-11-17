// Platter: a vinyl disc that turns with the playhead at 33 1/3 rpm of TRACK time (so pitch changes
// and reverse play are reflected). Static artwork is cached once per size; each frame only draws the
// lit ring and the position marker. M3 will attach scratch pointer handling to `element`
// (see angleAt() for the geometry helper); nothing grabs the record yet.

const REV_PER_SECOND = 100 / 3 / 60; // 33 1/3 rpm

export class Platter {
  /** @param {HTMLCanvasElement} canvas  @param {{letter:string}} o */
  constructor(canvas, { letter }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.letter = letter;
    this.cache = null;
    this.size = 0; // css px
    this.dpr = 1;
    this.needsFit = true;
    this.accent = '#38d4ff';
    this.drawn = { angle: NaN, playing: null };
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => {
        this.needsFit = true;
      });
      this.ro.observe(canvas);
    } else {
      window.addEventListener('resize', () => {
        this.needsFit = true;
      });
    }
  }

  /** The element future pointer handlers attach to. */
  get element() {
    return this.canvas;
  }

  /** Angle (radians, 0 = up, clockwise) of a pointer position about the platter centre, or null. */
  angleAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    if (!(r.width > 0) || !(r.height > 0)) return null;
    const a = Math.atan2(clientX - (r.left + r.width / 2), -(clientY - (r.top + r.height / 2)));
    return Number.isFinite(a) ? a : null;
  }

  // Only here is layout read: on resize, never per frame.
  _fit() {
    this.needsFit = false;
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const size = Math.floor(Math.min(r.width, r.height));
    if (!(size > 0)) {
      this.size = 0;
      return;
    }
    this.size = size;
    this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.accent = getComputedStyle(this.canvas).getPropertyValue('--accent').trim() || this.accent;
    this._buildCache(r.width, r.height);
    this.drawn = { angle: NaN, playing: null };
  }

  _buildCache(w, h) {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const R = this.size / 2;
    g.translate(w / 2, h / 2);
    // record body
    g.fillStyle = '#0b0b0c';
    g.beginPath();
    g.arc(0, 0, R * 0.94, 0, Math.PI * 2);
    g.fill();
    // grooves
    g.lineWidth = 1;
    for (let r = R * 0.42; r < R * 0.92; r += Math.max(2.2, R * 0.035)) {
      g.strokeStyle = (Math.round(r) & 1) ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.028)';
      g.beginPath();
      g.arc(0, 0, r, 0, Math.PI * 2);
      g.stroke();
    }
    // lead-in rim
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.beginPath();
    g.arc(0, 0, R * 0.93, 0, Math.PI * 2);
    g.stroke();
    // label
    g.fillStyle = '#25262a';
    g.beginPath();
    g.arc(0, 0, R * 0.36, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = this.accent;
    g.globalAlpha = 0.5;
    g.lineWidth = Math.max(1.5, R * 0.03);
    g.beginPath();
    g.arc(0, 0, R * 0.36, 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = '#ece8df';
    g.font = `700 ${Math.round(R * 0.34)}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(this.letter, 0, R * 0.02);
    // spindle
    g.fillStyle = '#0b0b0c';
    g.beginPath();
    g.arc(0, 0, R * 0.05, 0, Math.PI * 2);
    g.fill();
    // fixed light reflections: they do not turn with the record
    for (const rot of [-0.7, Math.PI - 0.7]) {
      const grad = g.createRadialGradient(0, 0, R * 0.4, 0, 0, R * 0.93);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(1, 'rgba(255,255,255,0.07)');
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, R * 0.93, rot - 0.28, rot + 0.28);
      g.closePath();
      g.fill();
    }
    this.cache = c;
  }

  /** Mark the artwork stale (e.g. accent colour changed). */
  invalidate() {
    this.needsFit = true;
  }

  /**
   * @param {number} pos      track position in seconds
   * @param {boolean} playing lights the ring while the deck plays
   * @returns {boolean} true if anything was drawn
   */
  draw(pos, playing) {
    if (this.needsFit) this._fit();
    if (!(this.size > 0) || !this.cache) return false;
    const angle = (((pos * REV_PER_SECOND) % 1) + 1) % 1 * Math.PI * 2;
    if (Math.abs(angle - this.drawn.angle) < 0.004 && playing === this.drawn.playing) return false;
    this.drawn = { angle, playing };

    const { ctx, dpr } = this;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;
    const R = this.size / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.cache, 0, 0, w, h);
    ctx.translate(w / 2, h / 2);

    // outer ring: lit in the deck colour only while playing
    ctx.lineWidth = Math.max(2, R * 0.045);
    ctx.strokeStyle = playing ? this.accent : 'rgba(236,232,223,0.16)';
    ctx.beginPath();
    ctx.arc(0, 0, R - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();

    // position marker: a bar from the label to the groove edge and a dot at the rim
    ctx.rotate(angle);
    ctx.fillStyle = '#ece8df';
    const bw = Math.max(2, R * 0.04);
    ctx.fillRect(-bw / 2, -R * 0.86, bw, R * 0.46);
    ctx.fillStyle = playing ? this.accent : '#ece8df';
    ctx.beginPath();
    ctx.arc(0, -R * 0.86, Math.max(2.5, R * 0.055), 0, Math.PI * 2);
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return true;
  }
}
