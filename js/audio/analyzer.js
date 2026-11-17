// Track analysis orchestration: time-sliced peak extraction, selection of a bounded BPM
// analysis window, and tempo detection in a Web Worker (with main-thread fallback).

import { PEAK_BASE, buildPeaks, downmixDecimateAsync, yieldToEventLoop } from './peaks.js';
import { analyzeTempo, pickAnalysisWindow } from './bpm-core.js';

const ANALYSIS_RATE = 11025; // target rate of the decimated mono signal
const ANALYSIS_SECONDS = 90;

/**
 * Runs on the freshly decoded channel data BEFORE it is transferred to the worklet.
 * Returns peaks plus (if needBpm) a small decimated mono window; nothing here keeps the
 * full-size channel arrays alive. Returns null if aborted.
 */
export async function prepareTrack({ left, right, sampleRate }, { needBpm }, shouldAbort) {
  const peaks = await buildPeaks(left, right, sampleRate, { shouldAbort });
  if (!peaks) return null;
  let bpmInput = null;
  if (needBpm) {
    const level0 = peaks.levels[0];
    const win = pickAnalysisWindow(level0.rms, PEAK_BASE / sampleRate, ANALYSIS_SECONDS);
    const factor = Math.max(1, Math.round(sampleRate / ANALYSIS_RATE));
    const mono = await downmixDecimateAsync(left, right, Math.floor(win.start * sampleRate), Math.floor(win.end * sampleRate), factor, {
      shouldAbort,
    });
    if (!mono) return null;
    bpmInput = { mono, sampleRate: sampleRate / factor, startTime: win.start };
  }
  return { peaks, bpmInput };
}

const abortError = () => Object.assign(new Error('analysis cancelled'), { name: 'AbortError' });

/**
 * Tempo detection jobs. The worker runs ONE job at a time; the others wait in our own queue, so
 * cancelling a queued job just removes it (the running job is untouched). Only cancelling the job
 * that is actually running terminates the worker (it is busy in a synchronous loop and cannot see
 * a message); the next queued job then starts on a fresh worker. On the main thread, a cancelled
 * job stops at its next time slice.
 */
export class TempoAnalyzer {
  constructor() {
    this.worker = null;
    this.failed = typeof Worker === 'undefined';
    this.queue = []; // jobs waiting for the worker
    this.running = null; // job currently in the worker
    this.nextId = 1;
  }

  _ensureWorker() {
    if (this.worker || this.failed) return;
    try {
      const w = new Worker(new URL('./bpm-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => {
        const job = this.running;
        if (!job || job.id !== e.data.id) return;
        this.running = null;
        if (e.data.error) this._runOnMain(job);
        else job.resolve(e.data.result);
        this._pump();
      };
      w.onerror = () => this._fail();
      this.worker = w;
    } catch {
      this._fail();
    }
  }

  // Worker could not start or died (e.g. no module-worker support): run everything on the main thread.
  _fail() {
    this.failed = true;
    try {
      this.worker?.terminate();
    } catch {}
    this.worker = null;
    const pending = [this.running, ...this.queue].filter(Boolean);
    this.running = null;
    this.queue = [];
    for (const job of pending) if (!job.cancelled) this._runOnMain(job);
  }

  _runOnMain(job) {
    const { mono, sampleRate, startTime } = job.input;
    job.onMain = true;
    analyzeTempo(mono, sampleRate, { startTime, yieldFn: yieldToEventLoop, shouldAbort: () => job.cancelled }).then(
      (r) => (job.cancelled ? job.reject(abortError()) : job.resolve(r)),
      job.reject,
    );
  }

  _pump() {
    if (this.running || !this.queue.length) return;
    this._ensureWorker();
    if (!this.worker) return; // _fail() already moved the jobs to the main thread
    const job = this.queue.shift();
    this.running = job;
    try {
      this.worker.postMessage({ id: job.id, ...job.input }); // copied, so the main-thread fallback still has it
    } catch {
      this.running = null;
      this._runOnMain(job);
      this._pump();
    }
  }

  /**
   * @param {{mono:Float32Array, sampleRate:number, startTime:number}} input
   * @returns {{promise:Promise<{bpm:number|null, offset:number, confidence:number}>, cancel:()=>void}}
   *          the promise rejects with an AbortError if cancelled
   */
  analyze(input) {
    const job = { id: this.nextId++, input, cancelled: false, onMain: false };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    if (this.failed) this._runOnMain(job);
    else {
      this.queue.push(job);
      this._pump();
    }
    const cancel = () => {
      if (job.cancelled) return;
      job.cancelled = true;
      const queued = this.queue.indexOf(job);
      if (queued >= 0) {
        this.queue.splice(queued, 1); // never started: nothing else is disturbed
        job.reject(abortError());
      } else if (this.running === job) {
        job.reject(abortError());
        this.running = null;
        try {
          this.worker?.terminate();
        } catch {}
        this.worker = null;
        this._pump(); // next queued job starts on a fresh worker
      } else {
        job.reject(abortError()); // main-thread job: stops at its next slice
      }
    };
    return { promise: job.promise, cancel };
  }
}
