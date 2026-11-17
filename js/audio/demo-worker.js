// Web Worker (module): renders a demo loop off the main thread.
//   in : { id: 'demo:...' }
//   out: { type:'progress', fraction } ... then { type:'done', left, right, sampleRate, length, duration, bpm, offset }
//        (the sample arrays are transferred, not copied) or { type:'error', message }
import { DEMOS, renderDemo } from './demo-synth.js';

self.onmessage = async (e) => {
  try {
    const def = DEMOS.find((d) => d.id === e.data?.id);
    if (!def) throw new Error('Unknown demo');
    let lastPost = 0;
    const r = await renderDemo(def, {
      onProgress: (fraction) => {
        const t = Date.now();
        if (t - lastPost > 100) {
          lastPost = t;
          self.postMessage({ type: 'progress', fraction });
        }
      },
    });
    self.postMessage({ type: 'done', ...r }, [r.left.buffer, r.right.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  }
};
