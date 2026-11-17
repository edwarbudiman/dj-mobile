import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIG_FILE_BYTES,
  DECODED_WARN_BYTES,
  LONG_SECONDS,
  decodedBytes,
  describeBeforeDecode,
  inspectAfterDecode,
  inspectBeforeDecode,
  looksLikeOutOfMemory,
  parseAudioHeader,
  peakDecodeBytes,
  readMediaDuration,
  toMB,
} from '../js/audio/memory-guard.js';

const MB = 1024 * 1024;

function wav({ seconds, rate = 44100, channels = 2, bits = 16, dataSizeField, extraChunk = false }) {
  const dataBytes = Math.round(seconds * rate) * channels * (bits / 8);
  const head = 12 + (extraChunk ? 8 + 4 : 0) + 8 + 16 + 8;
  const b = new Uint8Array(head);
  const dv = new DataView(b.buffer);
  const tag = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  let o = 12;
  if (extraChunk) {
    tag(o, 'LIST');
    dv.setUint32(o + 4, 4, true);
    o += 12;
  }
  tag(o, 'fmt ');
  dv.setUint32(o + 4, 16, true);
  dv.setUint16(o + 8, 1, true);
  dv.setUint16(o + 10, channels, true);
  dv.setUint32(o + 12, rate, true);
  dv.setUint32(o + 16, rate * channels * (bits / 8), true);
  dv.setUint16(o + 20, channels * (bits / 8), true);
  dv.setUint16(o + 22, bits, true);
  o += 24;
  tag(o, 'data');
  dv.setUint32(o + 4, dataSizeField ?? dataBytes, true);
  return { bytes: b, fileSize: head + dataBytes };
}

function aiff({ seconds, rate = 44100, channels = 2 }) {
  const frames = Math.round(seconds * rate);
  const b = new Uint8Array(12 + 8 + 18 + 8);
  const dv = new DataView(b.buffer);
  const tag = (o, s) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  tag(0, 'FORM');
  tag(8, 'AIFF');
  tag(12, 'COMM');
  dv.setUint32(16, 18);
  dv.setUint16(20, channels);
  dv.setUint32(22, frames);
  dv.setUint16(26, 16);
  // 80-bit extended: exponent 15 bits, 64-bit mantissa with the top bit set
  const exp = Math.floor(Math.log2(rate));
  dv.setUint16(28, 16383 + exp);
  const mant = BigInt(Math.round(rate * 2 ** (63 - exp)));
  dv.setBigUint64(30, mant);
  tag(38, 'SSND');
  return b;
}

test('decoded size is frames x channels x 4 bytes; the load peak is double', () => {
  const tenMin = { duration: 600, channels: 2, sampleRate: 44100 };
  assert.equal(decodedBytes(tenMin), 600 * 44100 * 2 * 4);
  assert.equal(toMB(decodedBytes(tenMin)), 202); // 211.7 million bytes = 202 MiB
  assert.equal(peakDecodeBytes(tenMin), 2 * decodedBytes(tenMin));
  assert.equal(decodedBytes({ duration: 600, channels: 1, sampleRate: 48000 }), 600 * 48000 * 4);
  assert.equal(decodedBytes({ duration: NaN, channels: 2, sampleRate: 44100 }), 0);
  // two decks of 10 minutes of 48 kHz stereo: the steady state the report quotes
  assert.equal(Math.round((2 * decodedBytes({ duration: 600, channels: 2, sampleRate: 48000 })) / 1e6), 461);
});

test('WAV header: duration, channels and rate; extra chunks, streaming size fields and junk are handled', () => {
  const a = wav({ seconds: 20 * 60 });
  const h = parseAudioHeader(a.bytes, a.fileSize);
  assert.equal(h.format, 'wav');
  assert.equal(h.channels, 2);
  assert.equal(h.sampleRate, 44100);
  assert.ok(Math.abs(h.duration - 1200) < 0.01);
  const b = wav({ seconds: 3, extraChunk: true, rate: 48000, channels: 1 });
  assert.ok(Math.abs(parseAudioHeader(b.bytes, b.fileSize).duration - 3) < 0.01, 'a LIST chunk before fmt');
  const c = wav({ seconds: 2, dataSizeField: 0xffffffff });
  assert.ok(Math.abs(parseAudioHeader(c.bytes, c.fileSize).duration - 2) < 0.01, 'a streaming WAV uses the file size');
  assert.equal(parseAudioHeader(new Uint8Array(100)), null);
  assert.equal(parseAudioHeader(new Uint8Array([1, 2, 3])), null);
  assert.equal(parseAudioHeader(undefined), null);
  const trunc = wav({ seconds: 5 }).bytes.slice(0, 30);
  assert.equal(parseAudioHeader(trunc), null, 'truncated header');
});

test('AIFF header: frames over the 80-bit sample rate', () => {
  const h = parseAudioHeader(aiff({ seconds: 16 * 60, rate: 44100 }));
  assert.equal(h.format, 'aiff');
  assert.equal(h.channels, 2);
  assert.ok(Math.abs(h.sampleRate - 44100) < 1, `${h.sampleRate}`);
  assert.ok(Math.abs(h.duration - 960) < 0.1, `${h.duration}`);
  assert.ok(Math.abs(parseAudioHeader(aiff({ seconds: 10, rate: 96000 })).duration - 10) < 0.01);
});

test('before decode: a big file or a WAV / AIFF over 15 minutes asks first; ordinary tracks do not', () => {
  const ok = inspectBeforeDecode({ size: 9 * MB });
  assert.equal(ok.warn, false, 'a 9 MB file is a normal track');
  const big = inspectBeforeDecode({ size: BIG_FILE_BYTES + 1 });
  assert.equal(big.warn, true);
  assert.ok(big.reasons.includes('big'));
  assert.ok(big.estimateBytes > 500 * MB && big.exact === false, 'an unknown-length file is a rough estimate');
  const long = inspectBeforeDecode({ size: 150 * MB, header: { duration: LONG_SECONDS + 60, channels: 2, sampleRate: 44100 } });
  assert.deepEqual(long.reasons.sort(), ['big', 'heavy', 'long']);
  assert.equal(long.exact, true);
  const shortWav = inspectBeforeDecode({ size: 50 * MB, header: { duration: 280, channels: 2, sampleRate: 44100 } });
  assert.equal(shortWav.warn, false, 'a 5 minute WAV is fine');
  const longSmall = inspectBeforeDecode({ size: 40 * MB, header: { duration: 1000, channels: 1, sampleRate: 22050 }, contextRate: 22050 });
  assert.deepEqual(longSmall.reasons, ['long'], 'long even though the file is small');
  assert.equal(longSmall.estimateBytes, decodedBytes({ duration: 1000, channels: 1, sampleRate: 22050 }));
  assert.equal(longSmall.peakBytes, 2 * longSmall.estimateBytes);
  const text = describeBeforeDecode('mix.wav', long, 150 * MB);
  assert.match(text.message, /mix\.wav/);
  assert.match(text.message, /about 16 minutes/);
  assert.match(text.detail, /Needs \d+ MB once decoded/);
});

test('B-1: a long compressed file is caught: headerless 50 MB, a 45 minute metadata duration; a short one is not', () => {
  // 50 MB with nothing readable: 50 MB / 16000 B/s (128 kbit/s) = 55 minutes -> asks
  const headerless = inspectBeforeDecode({ size: 50 * MB, header: null, mediaDuration: null });
  assert.equal(headerless.warn, true);
  assert.deepEqual(headerless.reasons, ['long']);
  assert.equal(headerless.exact, false);
  // the 43 MB / 45 min / 128 kbit/s MP3 from the review: the metadata says 45 minutes
  const mp3 = inspectBeforeDecode({ size: 43 * MB, mediaDuration: 45 * 60, contextRate: 48000 });
  assert.equal(mp3.warn, true);
  assert.deepEqual(mp3.reasons.sort(), ['heavy', 'long']);
  assert.equal(mp3.exact, true);
  assert.ok(Math.abs(mp3.estimateBytes / 1e6 - 1036) < 2, `${mp3.estimateBytes / 1e6} MB decoded`); // 2700 s x 48000 x 2 x 4
  assert.ok(mp3.peakBytes > 2e9, 'about 2 GB at the peak of the load');
  // a normal 4 minute 128 kbit/s MP3 (3.8 MB) with a known duration
  const song = inspectBeforeDecode({ size: 3.8 * MB, mediaDuration: 240, contextRate: 48000 });
  assert.equal(song.warn, false);
  // 14 minutes stereo at 48 kHz is under the long limit but still 'heavy'? no: 14 x 60 x 48000 x 8 = 322 MB > 250 MiB
  const fourteen = inspectBeforeDecode({ size: 20 * MB, mediaDuration: 14 * 60, contextRate: 48000 });
  assert.deepEqual(fourteen.reasons, ['heavy']);
  const ten = inspectBeforeDecode({ size: 15 * MB, mediaDuration: 10 * 60, contextRate: 48000 });
  assert.equal(ten.warn, false, 'a 10 minute track is allowed without a question');
  assert.equal(inspectBeforeDecode({ size: 15 * MB, mediaDuration: Infinity }).exact, false, 'a streaming duration is unknown: falls back to the size guess');
});

test('c-1: a size guess alone asks only above 60 MB or 25 guessed minutes; a 10 minute 320 kbit/s MP3 does not', () => {
  // 10 min x 320 kbit/s = 24 MB; at 128 kbit/s that guesses as 25 min: exactly the over-warning case
  const hiBitrate = inspectBeforeDecode({ size: 24_000_000 }); // 10 min x 320 kbit/s = 24 000 000 bytes
  assert.equal(hiBitrate.warn, false, 'an ordinary high-bitrate track does not trigger the dialog');
  assert.equal(hiBitrate.exact, false);
  assert.ok(Math.abs(hiBitrate.minutes - 25) < 1e-9, 'guessed as 25 minutes (2.5x too long), which is not above the 25 minute line');
  assert.equal(inspectBeforeDecode({ size: 22 * MB }).warn, false);
  const guessLong = inspectBeforeDecode({ size: 30 * MB }); // 31 guessed minutes
  assert.equal(guessLong.warn, true);
  assert.deepEqual(guessLong.reasons, ['long']);
  assert.equal(inspectBeforeDecode({ size: BIG_FILE_BYTES + 1, mediaDuration: null }).warn, true, 'over 60 MB always asks');
  // a size guess never reports 'heavy' on its own: only real durations do
  assert.ok(!inspectBeforeDecode({ size: 22 * MB }).reasons.includes('heavy'));
  const text = describeBeforeDecode('x.mp3', guessLong, 30 * MB);
  assert.match(text.message, /estimated from the file size/);
  assert.match(text.detail, /Could need roughly/);
  assert.doesNotMatch(describeBeforeDecode('x.wav', mp3Exact(), 3 * MB).message, /estimated/);
});

function mp3Exact() {
  return inspectBeforeDecode({ size: 40 * MB, mediaDuration: 1800 });
}

test('c-1: a stored library duration (and channel count) is used as the exact length', () => {
  const k = inspectBeforeDecode({ size: 40 * MB, knownDuration: 45 * 60, knownChannels: 2, contextRate: 48000 });
  assert.equal(k.exact, true);
  assert.deepEqual(k.reasons.sort(), ['heavy', 'long']);
  assert.equal(k.estimateBytes, decodedBytes({ duration: 2700, channels: 2, sampleRate: 48000 }));
  const mono = inspectBeforeDecode({ size: 10 * MB, knownDuration: 600, knownChannels: 1, contextRate: 48000 });
  assert.equal(mono.estimateBytes, decodedBytes({ duration: 600, channels: 1, sampleRate: 48000 }));
  assert.equal(mono.warn, false);
  // a known duration wins over a header and over metadata
  const wins = inspectBeforeDecode({ size: 10 * MB, knownDuration: 300, header: { duration: 5000, channels: 2 }, mediaDuration: 9000 });
  assert.equal(wins.minutes, 5);
  // unknown channels default to stereo; a bad stored value is ignored
  assert.equal(inspectBeforeDecode({ size: 10 * MB, knownDuration: 600 }).estimateBytes, decodedBytes({ duration: 600, channels: 2, sampleRate: 48000 }));
  assert.equal(inspectBeforeDecode({ size: 10 * MB, knownDuration: NaN }).exact, false);
});

test('b-8: the estimate uses the CONTEXT sample rate (decodeAudioData resamples), not the file\'s', () => {
  const at48 = inspectBeforeDecode({ size: 10 * MB, header: { duration: 600, channels: 2, sampleRate: 44100 }, contextRate: 48000 });
  const at44 = inspectBeforeDecode({ size: 10 * MB, header: { duration: 600, channels: 2, sampleRate: 44100 }, contextRate: 44100 });
  assert.equal(at48.estimateBytes, decodedBytes({ duration: 600, channels: 2, sampleRate: 48000 }));
  assert.equal(at44.estimateBytes, decodedBytes({ duration: 600, channels: 2, sampleRate: 44100 }));
  assert.ok(at48.estimateBytes > at44.estimateBytes * 1.08, 'about 9 % more at 48 kHz');
});

test('media duration: read from metadata with a timeout, always revoking the URL and releasing the element', async () => {
  const mk = (behave) => {
    const log = { revoked: [], created: [], loaded: 0 };
    class A {
      constructor() {
        log.created.push(this);
        this.attrs = {};
      }
      set src(v) {
        this._src = v;
        behave(this);
      }
      removeAttribute(k) {
        delete this.attrs[k];
      }
      load() {
        log.loaded++;
      }
    }
    return { log, env: { Audio: A, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: (u) => log.revoked.push(u) }, timeoutMs: 40 } };
  };
  const a = mk((el) => setTimeout(() => ((el.duration = 2700), el.onloadedmetadata()), 1));
  assert.equal(await readMediaDuration({}, a.env), 2700);
  assert.deepEqual(a.log.revoked, ['blob:x']);
  assert.equal(a.log.created[0].preload, 'metadata');
  assert.equal(a.log.loaded, 1);
  const stream = mk((el) => setTimeout(() => ((el.duration = Infinity), el.onloadedmetadata()), 1));
  assert.equal(await readMediaDuration({}, stream.env), null, 'Infinity is not a duration');
  const err = mk((el) => setTimeout(() => el.onerror(), 1));
  assert.equal(await readMediaDuration({}, err.env), null);
  const silent = mk(() => {}); // never answers
  const t = performance.now();
  assert.equal(await readMediaDuration({}, silent.env), null);
  assert.ok(performance.now() - t >= 35, 'waited for the timeout');
  // the default timeout is 1.5 s: an element that never answers is given up on within ~1.5 s
  const dflt = mk(() => {});
  const { timeoutMs: _ignored, ...envNoTimeout } = dflt.env;
  const t2 = performance.now();
  assert.equal(await readMediaDuration({}, envNoTimeout), null);
  const waited = performance.now() - t2;
  assert.ok(waited >= 1400 && waited < 2500, `default timeout ${waited.toFixed(0)} ms`);
  assert.deepEqual(silent.log.revoked, ['blob:x'], 'revoked after a timeout too');
  assert.equal(await readMediaDuration({}, { Audio: undefined, URL: {} }), null, 'no Audio element: unknown');
  const throwing = mk(() => {
    throw new Error('boom');
  });
  assert.equal(await readMediaDuration({}, throwing.env), null);
});

test('after decode: warn above ~250 MB (a 10 minute stereo track does not, a 20 minute one does)', () => {
  assert.equal(DECODED_WARN_BYTES, 250 * MB);
  assert.equal(inspectAfterDecode({ duration: 600, channels: 2, sampleRate: 48000 }).warn, false);
  const r = inspectAfterDecode({ duration: 1200, channels: 2, sampleRate: 44100 });
  assert.equal(r.warn, true);
  assert.ok(r.mb > 400);
});

test('out-of-memory failures are recognised by name and by message', () => {
  assert.equal(looksLikeOutOfMemory(new RangeError('Array buffer allocation failed')), true);
  assert.equal(looksLikeOutOfMemory(new Error('Out of memory')), true);
  assert.equal(looksLikeOutOfMemory({ name: 'QuotaExceededError', message: 'x' }), true);
  assert.equal(looksLikeOutOfMemory(new Error('Unable to decode audio data')), false);
  assert.equal(looksLikeOutOfMemory(null), false);
});
