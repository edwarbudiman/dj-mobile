#!/usr/bin/env node
// Spawns tools/serve.mjs on a free port, checks status/MIME/traversal handling, then stops it.
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const port = await new Promise((res) => {
  const s = net.createServer().listen(0, () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});

const child = spawn(process.execPath, [join(root, 'tools/serve.mjs'), '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  if (!ok) failures++;
};

// Raw request so ../ is not normalised away by fetch/URL.
const raw = (path) =>
  new Promise((resolveReq, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (r) => {
      r.resume();
      r.on('end', () => resolveReq(r.statusCode));
    });
    req.on('error', reject);
    req.end();
  });

try {
  for (let i = 0; i < 50 && !out.includes('Local:'); i++) await new Promise((r) => setTimeout(r, 100));
  check(out.includes('Local:'), 'server printed its URLs');

  const base = `http://127.0.0.1:${port}`;
  const cases = [
    ['/', 'text/html'],
    ['/index.html', 'text/html'],
    ['/js/main.js', 'text/javascript'],
    ['/js/audio/deck-processor.js', 'text/javascript'],
    ['/js/audio/bpm-worker.js', 'text/javascript'],
    ['/js/audio/bpm-core.js', 'text/javascript'],
    ['/js/ui/platter.js', 'text/javascript'],
    ['/css/app.css', 'text/css'],
  ];
  for (const [p, type] of cases) {
    const r = await fetch(base + p);
    await r.arrayBuffer();
    check(r.status === 200, `${p} -> 200 (got ${r.status})`);
    check((r.headers.get('content-type') || '').startsWith(type), `${p} content-type ${r.headers.get('content-type')}`);
    check(r.headers.get('cache-control') === 'no-cache', `${p} Cache-Control no-cache`);
  }
  check((await fetch(base + '/nope.js')).status === 404, 'missing file -> 404');
  for (const p of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/js/../../etc/passwd', '/.cert/key.pem', '/.vscode/settings.json']) {
    const s = await raw(p);
    check(s === 403 || s === 404, `${p} rejected (${s})`);
  }
} catch (e) {
  failures++;
  console.error('error', e);
} finally {
  child.kill('SIGTERM');
}
await new Promise((r) => child.on('exit', r));
console.log(failures ? `${failures} failure(s)` : 'serve smoke test OK');
process.exit(failures ? 1 : 0);
