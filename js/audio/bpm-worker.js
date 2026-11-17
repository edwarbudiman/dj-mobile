// Module worker wrapper around bpm-core.js. (Module workers: Safari 15+, Chrome 80+, Firefox 114+.
// analyzer.js falls back to chunked main-thread execution if this cannot be started.)
//
// in:  { id, mono: Float32Array, sampleRate, startTime }
// out: { id, result: {bpm, offset, confidence} } or { id, error }

import { analyzeTempo } from './bpm-core.js';

self.onmessage = async (e) => {
  const { id, mono, sampleRate, startTime } = e.data;
  try {
    const result = await analyzeTempo(mono, sampleRate, { startTime });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
