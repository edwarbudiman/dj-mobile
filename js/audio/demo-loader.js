// Builds a demo loop: in a Web Worker when one can be created (the main thread then does no synthesis at
// all), otherwise on the main thread with the time-budgeted, yielding renderDemo (no slice > ~6 ms).
//
// Any way the worker can fail falls back to the main-thread render: it cannot be constructed, it fires
// `error` / `messageerror`, or it stays SILENT for STALL_MS (a script fetch that stalls or dies without an
// event). The worker is terminated whenever it is given up on, so nothing leaks.

import { renderDemo } from './demo-synth.js';

export const STALL_MS = 3000; // no message from the worker for this long = give up on it

/**
 * @param {{id:string}} def  a DEMOS entry
 * @param {{useWorker?:boolean, onProgress?:(f:number)=>void, stallMs?:number,
 *          WorkerCtor?:typeof Worker, render?:typeof renderDemo}} [opts]  WorkerCtor / render are injectable for tests
 * @returns {Promise<{left:Float32Array,right:Float32Array,sampleRate:number,length:number,duration:number}>}
 */
export function buildDemo(def, { useWorker = true, onProgress, stallMs = STALL_MS, WorkerCtor = globalThis.Worker, render = renderDemo } = {}) {
  const fallback = () => render(def, { onProgress });
  if (!useWorker || typeof WorkerCtor === 'undefined') return fallback();
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new WorkerCtor(new URL('./demo-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(fallback());
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const fail = () => finish(fallback());
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(fail, stallMs);
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        watch(); // alive: the worker reports at least every ~100 ms while it renders
        onProgress?.(m.fraction);
      } else if (m.type === 'done') finish(m);
      else fail();
    };
    watch();
    try {
      worker.postMessage({ id: def.id });
    } catch {
      fail();
    }
  });
}
