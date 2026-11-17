// Screen Wake Lock: keep the screen on while a deck is playing, let it sleep otherwise.
//
// Feature-detected (navigator.wakeLock) and fully guarded: no support, a refused request or a lock the system
// revoked all just mean the screen may dim, as before. The browser drops a wake lock whenever the page is hidden,
// so it is requested again when the page becomes visible while something is still playing.

/**
 * @param {{nav?:Navigator, doc?:Document}} [env]
 * @returns {{update:(playing:boolean)=>void, readonly held:boolean, supported:boolean}}
 */
export function createWakeLock(env = {}) {
  const nav = env.nav ?? globalThis.navigator;
  const doc = env.doc ?? globalThis.document;
  const supported = !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function');
  let want = false;
  let sentinel = null;
  let pending = false;

  function acquire() {
    if (!supported || sentinel || pending) return;
    pending = true;
    let req;
    try {
      req = nav.wakeLock.request('screen');
    } catch {
      pending = false;
      return;
    }
    Promise.resolve(req).then(
      (s) => {
        pending = false;
        if (!want) {
          s.release?.().catch?.(() => {});
          return;
        }
        sentinel = s;
        s.addEventListener?.('release', () => {
          if (sentinel === s) sentinel = null; // revoked (page hidden, battery saver): re-requested on the next show
        });
      },
      () => {
        pending = false;
      },
    );
  }

  function release() {
    const s = sentinel;
    sentinel = null;
    try {
      s?.release?.().catch?.(() => {});
    } catch {
      /* already released */
    }
  }

  doc?.addEventListener?.('visibilitychange', () => {
    if (doc.visibilityState === 'visible' && want) acquire();
  });

  return {
    /** Call whenever the playing state of any deck changes. */
    update(playing) {
      want = !!playing;
      if (want) acquire();
      else release();
    },
    get held() {
      return sentinel !== null;
    },
    supported,
  };
}
