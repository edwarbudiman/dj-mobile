// demo-loader: the Worker path, and every way it can fail falling back to the main-thread render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemo } from '../js/audio/demo-loader.js';

const def = { id: 'demo:test' };
const FALLBACK = { left: new Float32Array(1), right: new Float32Array(1), from: 'main-thread' };
const render = async () => FALLBACK;

function stubWorker(behaviour) {
  const made = [];
  class W {
    constructor() {
      this.terminated = false;
      made.push(this);
      behaviour.ctor?.(this);
    }
    postMessage(m) {
      this.posted = m;
      behaviour.onPost?.(this);
    }
    terminate() {
      this.terminated = true;
    }
  }
  return { W, made };
}

test('a worker that never answers is given up on after the stall time, terminated, and the main-thread render is used', async () => {
  const { W, made } = stubWorker({});
  const t = performance.now();
  const r = await buildDemo(def, { WorkerCtor: W, stallMs: 40, render });
  assert.equal(r, FALLBACK);
  assert.ok(performance.now() - t >= 35, 'waited for the stall time');
  assert.equal(made.length, 1);
  assert.ok(made[0].terminated, 'the silent worker was terminated');
  assert.deepEqual(made[0].posted, { id: 'demo:test' });
});

test('progress messages keep a slow but live worker alive; done resolves with its result and terminates it', async () => {
  const { W, made } = stubWorker({
    onPost: (w) => {
      let n = 0;
      const tick = setInterval(() => {
        n++;
        if (n < 5) w.onmessage({ data: { type: 'progress', fraction: n / 5 } });
        else {
          clearInterval(tick);
          w.onmessage({ data: { type: 'done', left: new Float32Array(2), right: new Float32Array(2), from: 'worker' } });
        }
      }, 10); // each gap is far below stallMs, so a busy machine cannot make it look dead
    },
  });
  const progress = [];
  const r = await buildDemo(def, { WorkerCtor: W, stallMs: 1000, render, onProgress: (f) => progress.push(f) });
  assert.equal(r.from, 'worker');
  assert.deepEqual(progress, [0.2, 0.4, 0.6, 0.8]);
  assert.ok(made[0].terminated);
});

test('construction failure, error, messageerror and an unknown message all fall back; late messages are ignored', async () => {
  const throwing = class {
    constructor() {
      throw new Error('no module workers');
    }
  };
  assert.equal(await buildDemo(def, { WorkerCtor: throwing, render }), FALLBACK);
  for (const fire of [(w) => w.onerror(new Error('x')), (w) => w.onmessageerror({}), (w) => w.onmessage({ data: { type: 'error', message: 'boom' } })]) {
    const { W, made } = stubWorker({ onPost: (w) => setTimeout(() => fire(w), 1) });
    assert.equal(await buildDemo(def, { WorkerCtor: W, stallMs: 5000, render }), FALLBACK);
    assert.ok(made[0].terminated);
    made[0].onmessage({ data: { type: 'done', from: 'late' } }); // after settling: nothing happens
  }
  assert.equal(await buildDemo(def, { useWorker: false, render }), FALLBACK);
  assert.equal(await buildDemo(def, { WorkerCtor: undefined, render }), FALLBACK);
});

test('postMessage throwing falls back too', async () => {
  const { W, made } = stubWorker({
    onPost: () => {
      throw new Error('DataCloneError');
    },
  });
  assert.equal(await buildDemo(def, { WorkerCtor: W, stallMs: 5000, render }), FALLBACK);
  assert.ok(made[0].terminated);
});
