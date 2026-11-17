// Pure formatting helpers (no DOM).

function split(seconds) {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const tenths = Math.floor(s * 10);
  return { m: Math.floor(tenths / 600), s: Math.floor((tenths % 600) / 10), t: tenths % 10 };
}

/** 83.46 -> "1:23.4" */
export function formatTime(seconds) {
  const { m, s, t } = split(seconds);
  return `${m}:${String(s).padStart(2, '0')}.${t}`;
}

/** Remaining time with a leading minus: "-1:23.4". */
export function formatRemaining(seconds) {
  return '-' + formatTime(seconds);
}

/** Whole-second duration "3:07", or an en dash when unknown. */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '–:––';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
