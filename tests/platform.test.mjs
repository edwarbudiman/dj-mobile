// iOS audio session workaround, screen wake lock, service worker registration / update flow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enablePlaybackAudio, isIOS, makeSilentWav } from '../js/audio/ios-audio.js';
import { createWakeLock } from '../js/wake-lock.js';
import { initPwa, mayReload } from '../js/pwa.js';
import { parseAudioHeader } from '../js/audio/memory-guard.js';

// ---- iOS ---------------------------------------------------------------------------------------

test('isIOS: iPhone, iPad, iPadOS (a touch Mac), but not desktop or Android', () => {
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), true);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)' }), true);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(isIOS({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux armv81', maxTouchPoints: 5 }), false);
  assert.equal(isIOS(), false);
});

test('the silent WAV is a valid, tiny, all-zero PCM file', () => {
  const w = makeSilentWav(1, 8000);
  const h = parseAudioHeader(w);
  assert.equal(h.format, 'wav');
  assert.equal(h.channels, 1);
  assert.equal(h.sampleRate, 8000);
  assert.ok(Math.abs(h.duration - 1) < 1e-6);
  assert.equal(w.length, 44 + 16000);
  assert.ok(w.subarray(44).every((x) => x === 0));
});

function stubAudioEnv(nav) {
  const log = { created: [], revoked: [], played: 0, paused: 0 };
  class StubAudio {
    constructor() {
      this.attrs = {};
      log.created.push(this);
    }
    setAttribute(k, v) {
      this.attrs[k] = v;
    }
    removeAttribute() {}
    play() {
      log.played++;
      return Promise.reject(new Error('NotAllowedError')); // must be swallowed
    }
    pause() {
      log.paused++;
    }
  }
  return {
    log,
    env: {
      nav,
      Audio: StubAudio,
      Blob,
      URL: { createObjectURL: () => 'blob:silent', revokeObjectURL: (u) => log.revoked.push(u) },
    },
  };
}

test('playback session: audioSession where it exists; a silent loop only on iOS without it; nothing elsewhere', async () => {
  const a = stubAudioEnv({ audioSession: { type: 'auto' }, userAgent: 'iPhone' });
  const r1 = enablePlaybackAudio(a.env);
  assert.equal(r1.method, 'audioSession');
  assert.equal(a.env.nav.audioSession.type, 'playback');
  assert.equal(a.log.created.length, 0, 'no audio element when the API exists');

  const b = stubAudioEnv({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X)' });
  const r2 = enablePlaybackAudio(b.env);
  assert.equal(r2.method, 'silent-loop');
  assert.equal(b.log.played, 0, 'b-5: not playing until a deck plays');
  assert.equal(b.log.created[0].loop, true);
  assert.equal(b.log.created[0].attrs.playsinline, '');
  r2.setActive(true); // a deck started
  assert.equal(b.log.played, 1);
  await new Promise((r) => setTimeout(r, 0)); // the rejected play() promise was handled (no unhandled rejection)
  b.log.created[0].paused = true; // an interruption (call, Siri) paused the element
  r2.refresh(); // the next gesture restarts it
  assert.equal(b.log.played, 2);
  b.log.created[0].paused = false;
  r2.refresh();
  assert.equal(b.log.played, 2, 'not restarted while it is running');
  r2.setActive(false); // every deck stopped
  assert.equal(b.log.paused, 1);
  b.log.created[0].paused = true;
  r2.refresh();
  assert.equal(b.log.played, 2, 'not restarted when nothing is playing');
  r2.stop();
  assert.equal(b.log.paused, 2);
  assert.deepEqual(b.log.revoked, ['blob:silent'], 'the blob URL is revoked when the context closes');

  const c = stubAudioEnv({ userAgent: 'Mozilla/5.0 (Linux; Android 14)', platform: 'Linux', maxTouchPoints: 5 });
  assert.equal(enablePlaybackAudio(c.env).method, 'none');
  assert.equal(c.log.created.length, 0, 'Android and desktop get no element');
  assert.equal(enablePlaybackAudio({ nav: undefined }).method, 'none');
  const throwing = { audioSession: {} };
  Object.defineProperty(throwing.audioSession, 'type', { set() { throw new Error('nope'); } });
  assert.equal(enablePlaybackAudio({ nav: throwing }).method, 'none', 'never throws');
});

// ---- wake lock ---------------------------------------------------------------------------------

function stubWake() {
  const state = { requests: 0, releases: 0, sentinels: [], failNext: false };
  const nav = {
    wakeLock: {
      request: async () => {
        state.requests++;
        if (state.failNext) throw new Error('NotAllowedError');
        const listeners = [];
        const s = { addEventListener: (_t, f) => listeners.push(f), release: async () => void state.releases++, fire: () => listeners.forEach((f) => f()) };
        state.sentinels.push(s);
        return s;
      },
    },
  };
  const docListeners = [];
  const doc = { visibilityState: 'visible', addEventListener: (_t, f) => docListeners.push(f) };
  return { state, nav, doc, show: () => docListeners.forEach((f) => f()) };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('wake lock: held while something plays, released when nothing does, re-acquired when the page returns', async () => {
  const w = stubWake();
  const lock = createWakeLock({ nav: w.nav, doc: w.doc });
  assert.equal(lock.supported, true);
  lock.update(true);
  lock.update(true); // no second request while one is pending / held
  await tick();
  assert.equal(w.state.requests, 1);
  assert.equal(lock.held, true);
  lock.update(false);
  assert.equal(w.state.releases, 1);
  assert.equal(lock.held, false);
  lock.update(true);
  await tick();
  assert.equal(w.state.requests, 2);
  w.state.sentinels[1].fire(); // the system revoked it (page hidden)
  assert.equal(lock.held, false);
  w.show(); // page visible again, still playing
  await tick();
  assert.equal(w.state.requests, 3);
  assert.equal(lock.held, true);
  lock.update(false);
  w.show();
  await tick();
  assert.equal(w.state.requests, 3, 'not re-acquired when nothing plays');
});

test('wake lock: a stop that arrives before the grant releases it at once; refusals and missing API never throw', async () => {
  const w = stubWake();
  const lock = createWakeLock({ nav: w.nav, doc: w.doc });
  lock.update(true);
  lock.update(false); // before the request resolved
  await tick();
  assert.equal(lock.held, false);
  assert.equal(w.state.releases, 1);
  w.state.failNext = true;
  lock.update(true);
  await tick();
  assert.equal(lock.held, false);
  const none = createWakeLock({ nav: {}, doc: w.doc });
  assert.equal(none.supported, false);
  none.update(true);
  none.update(false);
  assert.equal(none.held, false);
});

// ---- service worker registration / update ---------------------------------------------------------

function stubSw({ search = '', secure = true, controller = {} } = {}) {
  const log = { registered: [], posted: [], reloads: 0, unregistered: 0, deletedCaches: [] };
  const swListeners = {};
  const regListeners = {};
  const waiting = { postMessage: (m) => log.posted.push(m) };
  const reg = { waiting: null, installing: null, addEventListener: (t, f) => (regListeners[t] = f), update: async () => {} };
  const nav = {
    serviceWorker: {
      controller,
      addEventListener: (t, f) => (swListeners[t] = f),
      register: async (url, opts) => (log.registered.push([url, opts]), reg),
      getRegistrations: async () => [{ unregister: async () => void log.unregistered++ }],
    },
  };
  const store = new Map();
  const win = {
    isSecureContext: secure,
    location: { search, reload: () => void log.reloads++ },
    addEventListener: () => {},
  };
  const doc = { readyState: 'complete', visibilityState: 'visible', addEventListener: () => {} };
  const env = {
    nav,
    win,
    doc,
    now: () => 1_000_000,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    cachesApi: { keys: async () => ['dj-mobile-abc', 'other'], delete: async (k) => void log.deletedCaches.push(k) },
  };
  return { log, env, swListeners, regListeners, reg, waiting, store };
}

test('registration is relative, scoped ./, and skipped on insecure pages or without service workers', async () => {
  const s = stubSw();
  assert.deepEqual(initPwa({ onUpdateReady() {} }, s.env), { enabled: true });
  await tick();
  assert.deepEqual(s.log.registered, [['./sw.js', { scope: './' }]]);
  assert.equal(initPwa({ onUpdateReady() {} }, stubSw({ secure: false }).env).enabled, false);
  const noSw = stubSw();
  delete noSw.env.nav.serviceWorker;
  assert.equal(initPwa({ onUpdateReady() {} }, noSw.env).enabled, false);
  const throwing = stubSw();
  throwing.env.nav.serviceWorker.register = () => {
    throw new Error('boom');
  };
  const errors = [];
  initPwa({ onUpdateReady() {}, onError: (e) => errors.push(e) }, throwing.env); // never throws
});

test('?nosw unregisters the worker and deletes only this app\'s caches, and does not register', async () => {
  const s = stubSw({ search: '?nosw' });
  const r = initPwa({ onUpdateReady() {} }, s.env);
  assert.equal(r.debugOff, true);
  await tick();
  await tick();
  assert.equal(s.log.unregistered, 1);
  assert.deepEqual(s.log.deletedCaches, ['dj-mobile-abc']);
  assert.equal(s.log.registered.length, 0);
});

test('update flow: a waiting worker offers the update; applying posts SKIP_WAITING and reloads exactly once', async () => {
  const s = stubSw();
  s.reg.waiting = s.waiting;
  let apply = null;
  initPwa({ onUpdateReady: (a) => (apply = a) }, s.env);
  await tick();
  assert.ok(apply, 'the page was told an update is ready');
  assert.equal(s.log.reloads, 0, 'no reload before the user applied the update');
  apply();
  assert.deepEqual(s.log.posted, [{ type: 'SKIP_WAITING' }]);
  s.swListeners.controllerchange();
  s.swListeners.controllerchange(); // a second event must not reload again
  assert.equal(s.log.reloads, 1);
});

test('the very first install claiming the page reloads nothing', async () => {
  const s = stubSw({ controller: null });
  initPwa({ onUpdateReady() {} }, s.env);
  await tick();
  s.swListeners.controllerchange(); // clients.claim()
  assert.equal(s.log.reloads, 0);
});

test('b-2: another window applied an update: reload at once when nothing plays, otherwise offer "Reload to finish updating"', async () => {
  const idle = stubSw();
  initPwa({ onUpdateReady() {}, isPlaying: () => false }, idle.env);
  await tick();
  idle.swListeners.controllerchange(); // a controller change this page did not ask for
  assert.equal(idle.log.reloads, 1, 'idle page reloads by itself');

  const busy = stubSw();
  let offered = null;
  initPwa({ onUpdateReady() {}, isPlaying: () => true, onStaleControl: (reload) => (offered = reload) }, busy.env);
  await tick();
  busy.swListeners.controllerchange();
  assert.equal(busy.log.reloads, 0, 'a playing page is not cut off');
  assert.equal(typeof offered, 'function', 'the page is offered the reload');
  offered();
  assert.equal(busy.log.reloads, 1);

  const looped = stubSw();
  looped.store.set('dj-mobile.swReload', String(1_000_000 - 1000));
  initPwa({ onUpdateReady() {} }, looped.env);
  await tick();
  looped.swListeners.controllerchange();
  assert.equal(looped.log.reloads, 0, 'the 10 s loop guard also covers this path');
});

test('update flow: an installing worker that finishes while a controller exists is announced; the very first install is not', async () => {
  const s = stubSw();
  let ready = 0;
  initPwa({ onUpdateReady: () => ready++ }, s.env);
  await tick();
  const worker = { state: 'installing', listeners: {}, addEventListener(t, f) { this.listeners[t] = f; }, postMessage() {} };
  s.reg.installing = worker;
  s.regListeners.updatefound();
  worker.state = 'installed';
  worker.listeners.statechange();
  assert.equal(ready, 1);

  const first = stubSw({ controller: null }); // nothing controlled this page yet: first visit
  let firstReady = 0;
  initPwa({ onUpdateReady: () => firstReady++ }, first.env);
  await tick();
  const w2 = { state: 'installing', listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } };
  first.reg.installing = w2;
  first.regListeners.updatefound();
  w2.state = 'installed';
  w2.listeners.statechange();
  assert.equal(firstReady, 0, 'a first install is not an "update"');
});

test('reload loop guard: no second reload within 10 s of the last one', async () => {
  assert.equal(mayReload(NaN, 5000), true);
  assert.equal(mayReload(1000, 5000), false);
  assert.equal(mayReload(1000, 12000), true);
  const s = stubSw();
  s.store.set('dj-mobile.swReload', String(1_000_000 - 2000)); // reloaded 2 s ago
  s.reg.waiting = s.waiting;
  let apply = null;
  initPwa({ onUpdateReady: (a) => (apply = a) }, s.env);
  await tick();
  apply();
  s.swListeners.controllerchange();
  assert.equal(s.log.reloads, 0, 'guarded');
});
