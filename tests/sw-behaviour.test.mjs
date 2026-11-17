// sw.js run against a stubbed ServiceWorkerGlobalScope: install, activate, fetch routing, update message.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SCOPE = 'https://example.test/dj-mobile/';
const handlers = {};
const stores = new Map(); // cache name -> Map(url -> Response)
let netCalls = [];
let netImpl = async () => new Response('net', { status: 200 });
let skipped = false;
let claimed = false;
let updated = 0;

class StubCache {
  constructor(name) {
    this.map = stores.get(name);
  }
  async put(url, res) {
    this.map.set(typeof url === 'string' ? url : url.url, res);
  }
  async match(url) {
    const k = typeof url === 'string' ? url : url.url;
    const hit = this.map.get(k.split('?')[0]) || this.map.get(k);
    return hit ? hit.clone() : undefined;
  }
}
globalThis.caches = {
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return new StubCache(name);
  },
  async keys() {
    return [...stores.keys()];
  },
  async delete(name) {
    return stores.delete(name);
  },
  async match(req, { cacheName } = {}) {
    const map = stores.get(cacheName);
    const k = typeof req === 'string' ? req : req.url;
    const hit = map && (map.get(k.split('?')[0]) || map.get(k));
    return hit ? hit.clone() : undefined;
  },
};
globalThis.fetch = async (req) => {
  netCalls.push(typeof req === 'string' ? req : req.url);
  return netImpl(req);
};
globalThis.self = {
  registration: { scope: SCOPE, update: async () => void updated++ },
  location: new URL(SCOPE),
  clients: { claim: async () => void (claimed = true) },
  skipWaiting: () => void (skipped = true),
  addEventListener: (type, fn) => {
    handlers[type] = fn;
  },
};
await import('../sw.js');

const run = async (type, init = {}) => {
  let p;
  handlers[type]({ ...init, waitUntil: (x) => (p = x), respondWith: (x) => (p = x) });
  return p;
};
const request = (url, { method = 'GET', mode = 'cors', headers = {} } = {}) => ({ url, method, mode, headers: new Headers(headers) });
const handled = (req) => {
  let responded = false;
  let p;
  handlers.fetch({ request: req, respondWith: (x) => ((responded = true), (p = x)) });
  return { responded, p };
};

const listed = (await import('node:fs')).readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const PRECACHE = [...(/const PRECACHE = \[([\s\S]*?)\];/.exec(listed)[1]).matchAll(/'([^']+)'/g)].map((m) => m[1]);
const CACHE = `dj-mobile-${/const VERSION = '([^']+)'/.exec(listed)[1]}`;

test('install downloads every precache entry (bypassing the HTTP cache) into the versioned cache, all or nothing', async () => {
  netCalls = [];
  netImpl = async (req) => new Response(`body of ${req.url}`, { status: 200 });
  await run('install');
  assert.equal(netCalls.length, PRECACHE.length);
  assert.ok(netCalls.every((u) => u.startsWith(SCOPE)), 'every URL is inside the scope: relative paths resolved against it');
  assert.ok(netCalls.includes(SCOPE) && netCalls.includes(`${SCOPE}js/audio/deck-processor.js`) && netCalls.includes(`${SCOPE}js/audio/demo-worker.js`));
  assert.equal(stores.get(CACHE).size, PRECACHE.length);
  // a failing file fails the whole install (the old worker keeps serving)
  stores.delete(CACHE);
  netImpl = async (req) => (req.url.endsWith('css/app.css') ? new Response('no', { status: 404 }) : new Response('ok'));
  await assert.rejects(run('install'), /css\/app\.css/);
  stores.delete(CACHE);
});

test('install does not skip waiting by itself; the page asks with SKIP_WAITING', async () => {
  assert.equal(skipped, false);
  await run('message', { data: { type: 'other' } });
  assert.equal(skipped, false);
  await run('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(skipped, true);
});

test('activate deletes only OLD dj-mobile-* caches, keeps ours and foreign caches, and claims the page', async () => {
  stores.set(CACHE, new Map());
  stores.set('dj-mobile-old1', new Map());
  stores.set('dj-mobile-old2', new Map());
  stores.set('someone-elses-cache', new Map());
  await run('activate');
  assert.ok(stores.has(CACHE) && stores.has('someone-elses-cache'));
  assert.ok(!stores.has('dj-mobile-old1') && !stores.has('dj-mobile-old2'));
  assert.ok(claimed);
});

test('fetch ignores non-GET, cross-origin, out-of-scope and Range requests', () => {
  for (const req of [
    request(`${SCOPE}api`, { method: 'POST' }),
    request('https://cdn.example.net/x.js'),
    request('https://example.test/other-app/index.html'),
    request(`${SCOPE}track.mp3`, { headers: { range: 'bytes=0-' } }),
  ]) assert.equal(handled(req).responded, false, req.url);
});

test('static assets: cache-first from the versioned snapshot, never refreshed or stored behind its back', async () => {
  stores.set(CACHE, new Map([[`${SCOPE}js/main.js`, new Response('cached main')]]));
  netCalls = [];
  const hit = handled(request(`${SCOPE}js/main.js?v=2`));
  assert.ok(hit.responded);
  assert.equal(await (await hit.p).text(), 'cached main');
  assert.deepEqual(netCalls, [], 'no network for a cached asset (and no background refresh that could mix versions)');
  netImpl = async () => new Response('from net');
  const miss = handled(request(`${SCOPE}js/unknown.js`));
  assert.equal(await (await miss.p).text(), 'from net');
  assert.equal(stores.get(CACHE).has(`${SCOPE}js/unknown.js`), false, 'an unknown file is not added to the cache');
});

test('navigation: network first; same page -> network copy; offline -> cached page', async () => {
  stores.set(CACHE, new Map([[`${SCOPE}index.html`, new Response('<html>v1</html>')]]));
  netImpl = async () => new Response('<html>v1</html>');
  assert.equal(await (await handled(request(SCOPE, { mode: 'navigate' })).p).text(), '<html>v1</html>');
  netImpl = async () => {
    throw new TypeError('offline');
  };
  const off = await handled(request(`${SCOPE}?nosw`, { mode: 'navigate' })).p;
  assert.equal(await off.text(), '<html>v1</html>', 'offline falls back to the cached page');
});

test('navigation: a changed page means a new version: serve the cached page (consistent with cached modules) and look for the new worker', async () => {
  stores.set(CACHE, new Map([[`${SCOPE}index.html`, new Response('<html>old</html>')]]));
  netImpl = async () => new Response('<html>NEW</html>');
  updated = 0;
  const res = await handled(request(SCOPE, { mode: 'navigate' })).p;
  assert.equal(await res.text(), '<html>old</html>');
  assert.equal(updated, 1);
});

test('b-3: other pages in the scope (README, an icon URL) are not replaced by index.html and never trigger an update check', async () => {
  stores.set(CACHE, new Map([[`${SCOPE}index.html`, new Response('<html>old</html>')], [`${SCOPE}icons/icon-192.png`, new Response('cached icon')]]));
  netImpl = async () => new Response('# readme from the network');
  updated = 0;
  const res = await handled(request(`${SCOPE}README.md`, { mode: 'navigate' })).p;
  assert.equal(await res.text(), '# readme from the network');
  assert.equal(updated, 0);
  const index = await handled(request(`${SCOPE}index.html?x=1`, { mode: 'navigate' })).p; // the app page, with a query
  assert.equal(await index.text(), '<html>old</html>', 'index.html with a query is still the app page');
  assert.equal(updated, 1);
  netImpl = async () => {
    throw new TypeError('offline');
  };
  const offline = await handled(request(`${SCOPE}icons/icon-192.png`, { mode: 'navigate' })).p;
  assert.equal(await offline.text(), 'cached icon', 'offline: the cache is the fallback');
});

test('navigation: a server error falls back to the cached page', async () => {
  stores.set(CACHE, new Map([[`${SCOPE}index.html`, new Response('<html>v1</html>')]]));
  netImpl = async () => new Response('bad gateway', { status: 502 });
  assert.equal(await (await handled(request(SCOPE, { mode: 'navigate' })).p).text(), '<html>v1</html>');
});
