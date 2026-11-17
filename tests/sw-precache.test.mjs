// The service worker's precache list must be complete and true, its version must track the files, and the
// manifest / registration must be relative (the app is hosted under /dj-mobile/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appShellFiles, shellHash } from '../tools/sw-hash.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swSource = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

function precacheList() {
  const m = /const PRECACHE = \[([\s\S]*?)\];/.exec(swSource);
  assert.ok(m, 'sw.js has a PRECACHE array');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

test('every file under js/, css/, icons/ plus index.html and the manifest is precached, and nothing listed is missing on disk', () => {
  const listed = precacheList();
  const disk = appShellFiles(ROOT);
  assert.ok(disk.length > 40, `found ${disk.length} app files`);
  assert.ok(disk.some((f) => f === 'js/audio/deck-processor.js') && disk.some((f) => f === 'js/audio/demo-worker.js'), 'worklet and workers are app files');
  const missing = disk.filter((f) => !listed.includes(f));
  assert.deepEqual(missing, [], `files not in PRECACHE (add them, then update VERSION): ${missing.join(', ')}`);
  const ghosts = listed.filter((f) => f !== './' && !fs.existsSync(path.join(ROOT, f)));
  assert.deepEqual(ghosts, [], `PRECACHE lists files that do not exist: ${ghosts.join(', ')}`);
  assert.equal(new Set(listed).size, listed.length, 'no duplicates');
  assert.ok(listed.includes('./'), 'the scope root itself is cached');
});

test('the cache version is the hash of the app shell: change any file and this fails until sw.js is updated', () => {
  const m = /const VERSION = '([^']+)';/.exec(swSource);
  assert.ok(m, 'sw.js has a VERSION line');
  assert.equal(m[1], shellHash(ROOT), `VERSION is stale: run "node tools/sw-hash.mjs" and paste its line over the VERSION line in sw.js`);
});

test('every path in the precache list, the manifest and the registration is relative', () => {
  for (const p of precacheList()) assert.ok(!p.startsWith('/') && !/^[a-z]+:/i.test(p), `absolute path in PRECACHE: ${p}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.id, './');
  assert.equal(manifest.name, 'DJ Mobile');
  assert.ok(manifest.short_name);
  assert.equal(manifest.orientation, 'landscape');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), icon.src);
    assert.ok(fs.existsSync(path.join(ROOT, icon.src)), `${icon.src} exists`);
  }
  for (const size of ['192x192', '512x512']) {
    for (const purpose of ['any', 'maskable']) assert.ok(manifest.icons.some((i) => i.sizes === size && i.purpose === purpose), `${size} ${purpose} icon`);
  }
  const main = fs.readFileSync(path.join(ROOT, 'js/pwa.js'), 'utf8');
  assert.ok(main.includes("register('./sw.js', { scope: './' })"), 'registration is relative');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('href="manifest.webmanifest"') && html.includes('href="icons/apple-touch-icon.png"'));
  assert.ok(/apple-mobile-web-app-status-bar-style" content="black-translucent"/.test(html) && /apple-mobile-web-app-capable/.test(html));
});

test('no root-absolute URL anywhere in html, css, js or the manifest (the app lives under a sub-path)', () => {
  const offenders = [];
  const scan = (rel) => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // src= / href= / url() / import / fetch / new URL / Worker / register whose string starts with a single "/"
    const re = /(?:src=|href=|url\(|import\s*\(?|from\s|fetch\(|new URL\(|new Worker\(|register\(|"(?:start_url|scope|id|src)":\s*)\s*["'(]\/(?!\/)/g;
    let m;
    while ((m = re.exec(text))) offenders.push(`${rel}: ${m[0]}`);
  };
  for (const f of [...appShellFiles(ROOT), 'sw.js']) if (/\.(html|css|js|webmanifest)$/.test(f)) scan(f);
  assert.deepEqual(offenders, []);
});
