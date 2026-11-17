// Service worker registration and the update flow.
//
//   - Registers ./sw.js (relative: the app lives under a sub-path) after the page has loaded, only on secure
//     pages (https or localhost), never throwing.
//   - ?nosw in the address unregisters the worker and deletes this app's caches (for debugging), then carries on
//     without one.
//   - When a new worker has finished installing while an old one controls the page, onUpdateReady(apply) is
//     called. apply() asks the waiting worker to take over and reloads ONCE when the new worker has taken
//     control. The first-ever install also fires 'controllerchange' (clients.claim): that reloads nothing.
//     If ANOTHER window applied the update, this page is suddenly controlled by the new worker too and would run
//     old code against the new cache: it reloads at once when no deck plays, else offers onStaleControl(reload).
//     A timestamp in sessionStorage stops any reload loop.

const RELOAD_KEY = 'dj-mobile.swReload';
const RELOAD_GUARD_MS = 10000;
const CHECK_EVERY_MS = 30 * 60 * 1000;

/** Pure: is it safe to reload now (not twice within RELOAD_GUARD_MS)? */
export function mayReload(lastReloadAt, now) {
  return !(Number.isFinite(lastReloadAt) && now - lastReloadAt >= 0 && now - lastReloadAt < RELOAD_GUARD_MS);
}

/**
 * @param {{onUpdateReady:(apply:()=>void)=>void, onStaleControl?:(reload:()=>void)=>void, isPlaying?:()=>boolean,
 *          onError?:(e:unknown)=>void}} o  onStaleControl: another window updated the app while a deck here is playing:
 *          offer "Reload to finish updating"; with nothing playing the page reloads by itself
 * @param {{nav?:Navigator, win?:Window, doc?:Document, now?:()=>number, storage?:Storage|null, cachesApi?:CacheStorage}} [env]  injectable for tests
 */
export function initPwa({ onUpdateReady, onStaleControl = () => {}, isPlaying = () => false, onError = () => {} }, env = {}) {
  const nav = env.nav ?? globalThis.navigator;
  const win = env.win ?? globalThis.window;
  const doc = env.doc ?? globalThis.document;
  const now = env.now ?? (() => Date.now());
  const cachesApi = env.cachesApi ?? globalThis.caches;
  let storage = null;
  try {
    storage = env.storage ?? win.sessionStorage;
  } catch {
    storage = null;
  }

  try {
    if (!nav || !('serviceWorker' in nav) || win.isSecureContext === false) return { enabled: false };
    const params = new URLSearchParams(win.location.search);

    if (params.has('nosw')) {
      nav.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .then(() => (cachesApi ? cachesApi.keys() : []))
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dj-mobile-')).map((k) => cachesApi.delete(k))))
        .catch(onError);
      return { enabled: false, debugOff: true };
    }

    let applying = false;
    let registration = null;

    const announce = (worker) => {
      onUpdateReady(() => {
        applying = true;
        worker.postMessage({ type: 'SKIP_WAITING' });
      });
    };

    const reloadNow = () => {
      let last = NaN;
      try {
        last = Number(storage?.getItem(RELOAD_KEY));
      } catch {
        last = NaN;
      }
      if (!mayReload(last, now())) return;
      try {
        storage?.setItem(RELOAD_KEY, String(now()));
      } catch {
        /* no storage: the flags below still limit it to one reload per event */
      }
      applying = false;
      win.location.reload();
    };

    let hadController = !!nav.serviceWorker.controller;
    nav.serviceWorker.addEventListener('controllerchange', () => {
      if (applying) return reloadNow(); // the user asked for this update
      if (!hadController) {
        hadController = true; // the very first install claiming this page: nothing to reload
        return;
      }
      // Another window applied an update and the new worker took over THIS page too. Its lazy loads (worklet,
      // workers) now come from the new cache under old page code, so finish the update: reload at once when
      // nothing is playing, otherwise offer it.
      if (isPlaying()) onStaleControl(reloadNow);
      else reloadNow();
    });

    const register = () => {
      nav.serviceWorker
        .register('./sw.js', { scope: './' })
        .then((reg) => {
          registration = reg;
          if (reg.waiting && nav.serviceWorker.controller) announce(reg.waiting);
          reg.addEventListener('updatefound', () => {
            const w = reg.installing;
            if (!w) return;
            w.addEventListener('statechange', () => {
              if (w.state === 'installed' && nav.serviceWorker.controller) announce(w);
            });
          });
        })
        .catch(onError);
    };
    if (doc.readyState === 'complete') register();
    else win.addEventListener('load', register, { once: true });

    // look for a new version when the app returns to the foreground (a home-screen app is rarely reloaded)
    let lastCheck = now();
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState !== 'visible' || !registration || now() - lastCheck < CHECK_EVERY_MS) return;
      lastCheck = now();
      registration.update().catch(() => {});
    });
    return { enabled: true };
  } catch (e) {
    onError(e);
    return { enabled: false };
  }
}
