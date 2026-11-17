import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TempoAnalyzer } from '../js/audio/analyzer.js';

// Node has no global Worker, so this exercises the main-thread fallback path and its cancellation.
function clicks(seconds, bpm, rate = 11025) {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let t = 0.2; t < seconds; t += 60 / bpm) {
    const s = Math.round(t * rate);
    for (let i = 0; i < 0.05 * rate && s + i < out.length; i++) out[s + i] = Math.exp(-i / (0.01 * rate)) * Math.sin((2 * Math.PI * 70 * i) / rate);
  }
  return out;
}

test('analysis runs and resolves via the main-thread fallback', async () => {
  const a = new TempoAnalyzer();
  const job = a.analyze({ mono: clicks(30, 128), sampleRate: 11025, startTime: 0 });
  const r = await job.promise;
  assert.ok(Math.abs(r.bpm - 128) < 0.1, `bpm ${r.bpm}`);
});

test('cancelling a queued job leaves the running worker alone; cancelling the running job restarts it', async () => {
  const made = [];
  globalThis.Worker = class {
    constructor() {
      this.posted = [];
      this.terminated = false;
      made.push(this);
    }
    postMessage(m) {
      this.posted.push(m.id);
    }
    terminate() {
      this.terminated = true;
    }
  };
  try {
    const a = new TempoAnalyzer();
    const input = { mono: new Float32Array(10), sampleRate: 11025, startTime: 0 };
    const first = a.analyze(input); // runs in the worker
    const second = a.analyze(input); // queued behind it
    const third = a.analyze(input);
    assert.equal(made.length, 1);
    assert.equal(made[0].posted.length, 1, 'only one job is in the worker at a time');
    second.cancel();
    await assert.rejects(second.promise, (e) => e.name === 'AbortError');
    assert.equal(made[0].terminated, false, 'cancelling a queued job must not terminate the worker');
    first.cancel(); // the running one
    await assert.rejects(first.promise, (e) => e.name === 'AbortError');
    assert.equal(made[0].terminated, true);
    assert.equal(made.length, 2, 'a fresh worker was created');
    assert.equal(made[1].posted.length, 1, 'the next queued job started on it');
    third.cancel();
    await assert.rejects(third.promise);
  } finally {
    delete globalThis.Worker;
  }
});

test('a cancelled job rejects with AbortError and does not disturb the next job', async () => {
  const a = new TempoAnalyzer();
  const first = a.analyze({ mono: clicks(60, 128), sampleRate: 11025, startTime: 0 });
  const second = a.analyze({ mono: clicks(30, 140), sampleRate: 11025, startTime: 0 });
  first.cancel();
  await assert.rejects(first.promise, (e) => e.name === 'AbortError');
  const r = await second.promise;
  assert.ok(Math.abs(r.bpm - 140) < 0.1, `bpm ${r.bpm}`);
});
