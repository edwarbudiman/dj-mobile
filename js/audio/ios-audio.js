// iOS silent-switch workaround.
//
// Web Audio on iOS follows the "ambient" audio category, so the hardware silent switch mutes it. Two ways to
// move the page to the "playback" category:
//   1. navigator.audioSession.type = 'playback'   (Safari 16.4+): a one-line setting, used when it exists.
//   2. otherwise, on iOS only: loop a silent <audio> element WHILE A DECK PLAYS (started from the Play tap,
//      paused when nothing plays, restarted on the next gesture after an interruption); WebKit then treats the
//      page as media playback. (Android and desktop never take this path, so they get no extra media
//      notification and no stray element.)
// Everything is feature-detected and wrapped in try/catch: a failure just leaves the old behaviour.

/** iPhone, iPad and iPod, including iPadOS which reports itself as a Mac with a touch screen. */
export function isIOS({ userAgent = '', platform = '', maxTouchPoints = 0 } = {}) {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

/** A WAV file of silence (16-bit mono PCM), as bytes. */
export function makeSilentWav(seconds = 1, sampleRate = 8000) {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const dataBytes = frames * 2;
  const buf = new Uint8Array(44 + dataBytes);
  const dv = new DataView(buf.buffer);
  const tag = (o, s) => {
    for (let i = 0; i < 4; i++) buf[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  tag(36, 'data');
  dv.setUint32(40, dataBytes, true);
  return buf; // the samples are already zero
}

/**
 * Switch the page to the playback audio category. Call it from the unlock gesture.
 * @returns {{method:'audioSession'|'silent-loop'|'none', stop:()=>void}}
 */
export function enablePlaybackAudio(env = {}) {
  const nav = env.nav ?? globalThis.navigator;
  const AudioCtor = env.Audio ?? globalThis.Audio;
  const URLApi = env.URL ?? globalThis.URL;
  const BlobCtor = env.Blob ?? globalThis.Blob;
  const none = { method: 'none', setActive() {}, refresh() {}, stop() {} };
  try {
    if (!nav) return none;
    if ('audioSession' in nav && nav.audioSession) {
      nav.audioSession.type = 'playback';
      return { method: 'audioSession', setActive() {}, refresh() {}, stop() {} };
    }
    if (!isIOS(nav) || !AudioCtor || !URLApi || !BlobCtor) return none;
    const url = URLApi.createObjectURL(new BlobCtor([makeSilentWav()], { type: 'audio/wav' }));
    const el = new AudioCtor();
    el.src = url;
    el.loop = true;
    el.setAttribute?.('playsinline', '');
    el.setAttribute?.('aria-hidden', 'true');
    // The element plays only while a deck plays (setActive), so it never keeps the audio session alive in the
    // background or shows a lock-screen control for nothing. Starting it needs a user gesture: Play is one.
    let wanted = false;
    const start = () => {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    };
    return {
      method: 'silent-loop',
      /** Any deck playing? Starts or pauses the silent loop. */
      setActive(on) {
        wanted = !!on;
        try {
          if (wanted) start();
          else el.pause();
        } catch {
          /* no gesture yet: refresh() tries again on the next one */
        }
      },
      /** Call on every user gesture: after a phone call or Siri the system pauses the element; this restarts it. */
      refresh() {
        if (wanted && el.paused) start();
      },
      stop() {
        try {
          el.pause();
          el.removeAttribute?.('src');
          URLApi.revokeObjectURL(url);
        } catch {
          /* already gone */
        }
      },
    };
  } catch {
    return none;
  }
}
