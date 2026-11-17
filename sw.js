// DJ Mobile service worker: makes the app work offline after the first visit.
//
// Classic script (no import/export): browsers register it as one. Every URL is relative to the worker's scope
// (self.registration.scope), because the app is hosted under a sub-path (/dj-mobile/).
//
// STRATEGY
//  - Install: download the whole app shell into a NEW cache named dj-mobile-<VERSION> (all or nothing: if any file
//    fails, the install fails and the old worker and cache keep serving). The new worker then WAITS; it does not
//    take over by itself.
//  - Static assets (js, css, icons, manifest): cache-first from the versioned cache, never refreshed in the
//    background. A cache is therefore an immutable snapshot of one app version, and a page can never run a mix
//    of old and new modules.
//  - Navigations to the app page (the scope URL or index.html, any query): network first (4 s timeout) with the
//    cached index.html as the offline fallback. Any other page opened in the scope goes straight to the network
//    (cache only when offline). If the network
//    index.html differs from the cached one, a new version exists: serve the cached page (consistent with the
//    cached modules) and ask the browser to look for the new worker (registration.update()); js/pwa.js then shows
//    "Update ready".
//  - Update: when the page sends {type:'SKIP_WAITING'} the waiting worker activates, deletes OLD dj-mobile-*
//    caches (only ours) and claims the page, which reloads once on 'controllerchange'.
//  - Never touched: non-GET requests, cross-origin requests, Range requests (media), anything outside the scope.
//    User audio never reaches this worker (files are read from <input type=file> and IndexedDB, and blob: URLs are
//    not intercepted).
//
// VERSION is a hash of every file listed below (node tools/sw-hash.mjs prints the line). When any app file
// changes, run that tool and paste its output over the VERSION line: tests/sw-precache.test.mjs fails until you
// do, and it also fails if a file under js/, css/ or icons/ is missing from PRECACHE (or listed but absent).

const VERSION = '736b95d536';
const CACHE_PREFIX = 'dj-mobile-';
const CACHE = CACHE_PREFIX + VERSION;
const NAVIGATION_TIMEOUT_MS = 4000;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'js/audio/analyzer.js',
  'js/audio/bpm-core.js',
  'js/audio/bpm-worker.js',
  'js/audio/cue-math.js',
  'js/audio/deck-processor.js',
  'js/audio/deck.js',
  'js/audio/demo-loader.js',
  'js/audio/demo-synth.js',
  'js/audio/demo-worker.js',
  'js/audio/engine.js',
  'js/audio/filter-math.js',
  'js/audio/ios-audio.js',
  'js/audio/loop-math.js',
  'js/audio/load-policy.js',
  'js/audio/memory-guard.js',
  'js/audio/mixer-math.js',
  'js/audio/peaks.js',
  'js/audio/playhead-math.js',
  'js/audio/scratch-math.js',
  'js/audio/sync-math.js',
  'js/main.js',
  'js/pwa.js',
  'js/store/db.js',
  'js/store/persist.js',
  'js/ui/confirm.js',
  'js/ui/deck-view.js',
  'js/ui/fader.js',
  'js/ui/format.js',
  'js/ui/knob.js',
  'js/ui/library-view.js',
  'js/ui/mixer-view.js',
  'js/ui/pads.js',
  'js/ui/platter.js',
  'js/ui/scratch-arm.js',
  'js/ui/scratch.js',
  'js/ui/tap.js',
  'js/ui/toast.js',
  'js/ui/waveform.js',
  'js/wake-lock.js',
];

const scopeUrl = (p) => new URL(p, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map(async (p) => {
          const url = scopeUrl(p);
          const res = await fetch(new Request(url, { cache: 'reload' })); // bypass the HTTP cache: the snapshot must be fresh
          if (!res.ok) throw new Error(`precache ${p}: HTTP ${res.status}`);
          await cache.put(url, res);
        }),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(self.registration.scope)) return;
  if (req.headers.has('range')) return;
  if (req.mode !== 'navigate') event.respondWith(fromCache(req));
  else event.respondWith(isAppPage(url) ? navigate(req) : otherNavigation(req));
});

/** The app page: the scope URL or index.html, with any query string (?nosw ...). */
function isAppPage(url) {
  const base = new URL(self.registration.scope).pathname;
  return url.pathname === base || url.pathname === `${base}index.html`;
}

/** Any other page opened inside the scope (a README, an icon URL): straight to the network; the cache only if offline. */
async function otherNavigation(req) {
  try {
    return await fetch(req);
  } catch {
    const hit = await caches.match(req, { cacheName: CACHE, ignoreSearch: true });
    return hit || Response.error();
  }
}

async function fromCache(req) {
  const hit = await caches.match(req, { cacheName: CACHE, ignoreSearch: true });
  return hit || fetch(req);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function navigate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(scopeUrl('index.html'));
  try {
    const net = await withTimeout(fetch(req), NAVIGATION_TIMEOUT_MS);
    if (!net.ok) return cached || net;
    if (cached) {
      const [fresh, old] = await Promise.all([net.clone().text(), cached.clone().text()]);
      if (fresh !== old) {
        // a newer app exists: keep this page consistent with the cached modules and fetch the new worker
        self.registration.update().catch(() => {});
        return cached;
      }
    }
    return net;
  } catch {
    return cached || Response.error();
  }
}
