// Memory guard: pure estimates and thresholds (no DOM, no Web Audio).
//
// A decoded track costs frames x channels x 4 bytes (32-bit float). While loading, the browser's decoded buffer
// and our own copy exist side by side, so the peak is about twice that; afterwards only the copy (inside the
// deck's AudioWorklet) remains, and the decoded buffer is dropped.
//
//   10 min stereo @ 44.1 kHz : 211.7 MB steady, ~423 MB at the peak of a load
//   10 min stereo @ 48 kHz   : 230.4 MB steady, ~461 MB at the peak of a load
//   two such decks           : ~423-461 MB steady; loading the second one peaks at ~635-691 MB
//   (a mono track costs half; waveform peaks add well under 1 MB)

export const BIG_FILE_BYTES = 60 * 1024 * 1024; // warn before decoding a file larger than this...
export const LONG_SECONDS = 15 * 60; // ...or a WAV / AIFF whose header says it is longer than this
export const DECODED_WARN_BYTES = 250 * 1024 * 1024; // warn (once) after decoding something this big
export const HEADER_BYTES = 64 * 1024; // how much of the file start is enough to read a WAV / AIFF header

const GUESS_BYTES_PER_SECOND = 16000; // a compressed file of unknown length: 128 kbit/s (long-leaning, so it errs towards asking)
const GUESS_RATE = 48000;
export const GUESS_LONG_SECONDS = 25 * 60; // a guess from the file size alone must exceed this to ask
const GUESS_CHANNELS = 2;

/** Bytes of decoded float audio. */
export function decodedBytes({ duration, channels, sampleRate }) {
  if (!(duration > 0) || !(channels > 0) || !(sampleRate > 0)) return 0;
  return Math.ceil(duration * sampleRate) * channels * 4;
}

/** Peak while loading: the decoded buffer plus our copy. */
export function peakDecodeBytes(info) {
  return decodedBytes(info) * 2;
}

export const toMB = (bytes) => Math.round(bytes / (1024 * 1024));

const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16be = (b, o) => (b[o] << 8) | b[o + 1];

/**
 * Read the length of a WAV or AIFF file from the first bytes. Anything else (or anything malformed) is null.
 * @param {Uint8Array} b  at least the first HEADER_BYTES of the file (or all of it)
 * @param {number} [fileSize]  used for streaming WAVs whose data size field is 0 / 0xFFFFFFFF
 * @returns {null|{format:'wav'|'aiff', duration:number, channels:number, sampleRate:number}}
 */
export function parseAudioHeader(b, fileSize) {
  try {
    if (!b || b.length < 24) return null;
    if (!(fileSize >= 0)) fileSize = b.length;
    if (tag(b, 0) === 'RIFF' && tag(b, 8) === 'WAVE') {
      let channels = 0;
      let byteRate = 0;
      let sampleRate = 0;
      for (let o = 12; o + 8 <= b.length; ) {
        const id = tag(b, o);
        const size = u32le(b, o + 4);
        if (id === 'fmt ' && o + 8 + 16 <= b.length) {
          channels = u16le(b, o + 10);
          sampleRate = u32le(b, o + 12);
          byteRate = u32le(b, o + 16);
        } else if (id === 'data') {
          if (!(byteRate > 0)) return null;
          const dataStart = o + 8;
          const bytes = size === 0 || size === 0xffffffff || dataStart + size > fileSize ? fileSize - dataStart : size;
          return { format: 'wav', duration: Math.max(0, bytes) / byteRate, channels, sampleRate };
        }
        o += 8 + size + (size & 1);
      }
      return null;
    }
    if (tag(b, 0) === 'FORM' && (tag(b, 8) === 'AIFF' || tag(b, 8) === 'AIFC')) {
      for (let o = 12; o + 8 <= b.length; ) {
        const id = tag(b, o);
        const size = u32be(b, o + 4);
        if (id === 'COMM' && o + 8 + 18 <= b.length) {
          const channels = u16be(b, o + 8);
          const frames = u32be(b, o + 10);
          const exp = u16be(b, o + 16) & 0x7fff;
          const mant = u32be(b, o + 18) * 4294967296 + u32be(b, o + 22);
          const sampleRate = mant * Math.pow(2, exp - 16383 - 63); // 80-bit extended float
          if (!(sampleRate > 0)) return null;
          return { format: 'aiff', duration: frames / sampleRate, channels, sampleRate };
        }
        o += 8 + size + (size & 1);
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Read a file's real duration WITHOUT decoding it: an <audio preload="metadata"> element on an object URL reads
 * only the headers (MP3, AAC / M4A, OGG, WAV, FLAC in the target browsers). Resolves seconds, or null when it
 * cannot be read within timeoutMs. The URL is always revoked and the element released.
 */
export function readMediaDuration(blob, { timeoutMs = 1500, Audio: AudioCtor = globalThis.Audio, URL: URLApi = globalThis.URL } = {}) {
  return new Promise((resolve) => {
    let el = null;
    let url = null;
    let timer = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (el) {
          el.onloadedmetadata = el.onerror = null;
          el.removeAttribute?.('src');
          el.load?.(); // drop the resource
        }
        if (url) URLApi.revokeObjectURL(url);
      } catch {
        /* nothing to clean */
      }
      resolve(value);
    };
    try {
      if (!AudioCtor || !URLApi || !blob) return finish(null);
      url = URLApi.createObjectURL(blob);
      el = new AudioCtor();
      el.preload = 'metadata';
      el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null); // Infinity = streaming: unknown
      el.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), timeoutMs);
      el.src = url;
    } catch {
      finish(null);
    }
  });
}

/**
 * Should loading this file ask first? The decoded size is estimated at the AudioContext's sample rate (decoding
 * resamples to it), from the real duration when one is known (a WAV / AIFF header, or media metadata), otherwise
 * from a conservative size-based guess (128 kbit/s = 16000 bytes per second, which over-estimates length, so errs
 * towards asking).
 * @param {{size:number, header?:ReturnType<typeof parseAudioHeader>, mediaDuration?:number|null, contextRate?:number}} f
 * @returns {{warn:boolean, reasons:string[], estimateBytes:number, peakBytes:number, minutes:number|null, exact:boolean}}
 */
export function inspectBeforeDecode({ size, header = null, mediaDuration = null, knownDuration = null, knownChannels = null, contextRate = GUESS_RATE }) {
  const rate = contextRate > 0 ? contextRate : GUESS_RATE;
  let duration = null;
  let channels = GUESS_CHANNELS;
  let exact = false;
  if (knownDuration > 0 && Number.isFinite(knownDuration)) {
    // a library track whose length was stored the first time it loaded: no need to read anything
    duration = knownDuration;
    channels = knownChannels > 0 ? knownChannels : GUESS_CHANNELS;
    exact = true;
  } else if (header && header.duration > 0) {
    duration = header.duration;
    channels = header.channels || GUESS_CHANNELS;
    exact = true;
  } else if (mediaDuration > 0 && Number.isFinite(mediaDuration)) {
    duration = mediaDuration;
    exact = true;
  } else if (size > 0) {
    duration = size / GUESS_BYTES_PER_SECOND;
  }
  const est = duration > 0 ? decodedBytes({ duration, channels, sampleRate: rate }) : 0;
  const reasons = [];
  if (exact) {
    if (duration > LONG_SECONDS) reasons.push('long');
    if (est > DECODED_WARN_BYTES) reasons.push('heavy');
  } else if (duration > GUESS_LONG_SECONDS) {
    // Only a size guess: 128 kbit/s over-estimates the length of a high-bitrate file (a 10 minute 320 kbit/s MP3
    // guesses as 25 minutes), so ordinary tracks must not trigger the dialog. Ask above 25 guessed minutes.
    reasons.push('long');
  }
  if (size > BIG_FILE_BYTES) reasons.push('big');
  return { warn: reasons.length > 0, reasons, estimateBytes: est, peakBytes: est * 2, minutes: duration > 0 ? duration / 60 : null, exact };
}

/** Text for the "very large file" dialog. */
export function describeBeforeDecode(name, info, size) {
  const mb = toMB(size);
  const when = info.minutes
    ? info.exact
      ? `about ${Math.round(info.minutes)} minutes long`
      : `${mb} MB, which is roughly ${Math.round(info.minutes)} minutes (the length is estimated from the file size)`
    : `${mb} MB`;
  return {
    title: 'This is a very large file',
    message: `"${name}" is ${when}. Decoding it can use a lot of memory, and a phone may run out and close the page.`,
    detail: `${info.exact ? 'Needs' : 'Could need roughly'} ${toMB(info.estimateBytes)} MB once decoded (about ${toMB(info.peakBytes)} MB while loading). A shorter file loads faster and is safer.`,
  };
}

/** Decoded audio so large that two decks of it may not fit on a phone. */
export function inspectAfterDecode(info) {
  const bytes = decodedBytes(info);
  return { warn: bytes > DECODED_WARN_BYTES, bytes, mb: toMB(bytes) };
}

/** Does this decode / allocation failure look like running out of memory? */
export function looksLikeOutOfMemory(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || err);
  return name === 'RangeError' || name === 'QuotaExceededError' || /out of memory|allocation failed|array buffer allocation|cannot allocate|memory|too large|quota/i.test(msg);
}
