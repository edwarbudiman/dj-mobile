#!/usr/bin/env node
// Zero-dependency static server for the DJ Mobile PWA.
//
//   node tools/serve.mjs [--port 8080] [--https]
//
// Serves the project root on 0.0.0.0 and prints localhost + LAN URLs. Phones need a secure
// context for AudioWorklet: http://localhost works on the same machine, but another device
// on your Wi-Fi needs https, so use --https (self-signed certificate, see below).

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERT_DIR = path.join(ROOT, '.cert');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

function fail(message) {
  console.error(`\nserve: ${message}\n`);
  process.exit(1);
}

// ---- args ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { port: 8080, https: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--https') opts.https = true;
    else if (a === '--port' || a === '-p') opts.port = argv[++i];
    else if (a.startsWith('--port=')) opts.port = a.slice(7);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node tools/serve.mjs [--port 8080] [--https]');
      process.exit(0);
    } else fail(`unknown argument "${a}". Usage: node tools/serve.mjs [--port 8080] [--https]`);
  }
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid port "${opts.port}"`);
  opts.port = port;
  return opts;
}

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// ---- https: self-signed certificate via the openssl CLI ----------------------------------

function ensureCert(ips) {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  const ipsPath = path.join(CERT_DIR, 'ips.json');
  const wanted = JSON.stringify([...ips].sort());

  let current = null;
  try {
    current = fs.readFileSync(ipsPath, 'utf8');
  } catch {}
  if (current === wanted && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), fresh: false };
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  const r = spawnSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
      '-keyout', keyPath, '-out', certPath, '-subj', '/CN=dj-mobile', '-addext', `subjectAltName=${san}`],
    { encoding: 'utf8' },
  );
  if (r.error && r.error.code === 'ENOENT') {
    fail('--https needs the "openssl" command, which was not found on your PATH.\n' +
      '  macOS: it ships with the system (or `brew install openssl`).\n' +
      '  Debian/Ubuntu: `sudo apt install openssl`.  Windows: install Git for Windows or OpenSSL and add it to PATH.\n' +
      '  Or run without --https and use http://localhost on this machine only.');
  }
  if (r.error || r.status !== 0) {
    fail(`openssl failed to create the certificate (exit ${r.status}).\n${r.stderr || r.error?.message || ''}`);
  }
  fs.writeFileSync(ipsPath, wanted);
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), fresh: true };
}

// ---- request handling ---------------------------------------------------------------------

function resolvePath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const segments = decoded.split(/[\\/]+/).filter(Boolean);
  // No traversal, and no dotfiles/dot-directories (.cert, .git, ...).
  if (segments.some((s) => s === '..' || s.startsWith('.'))) return null;
  const full = path.resolve(ROOT, ...segments);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const urlPath = (req.url || '/').split('?')[0].split('#')[0];
  let file = resolvePath(urlPath);
  if (!file) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });

  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      file = path.join(file, 'index.html');
      return fs.stat(file, (e2, st2) => (e2 || !st2.isFile() ? notFound(res) : serveFile(req, res, file, st2)));
    }
    if (err || !st.isFile()) return notFound(res);
    serveFile(req, res, file, st);
  });
}

function notFound(res) {
  send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

function serveFile(req, res, file, st) {
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

// ---- main ---------------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const ips = lanAddresses();
const scheme = opts.https ? 'https' : 'http';

let server;
let freshCert = false;
if (opts.https) {
  const { key, cert, fresh } = ensureCert(ips);
  freshCert = fresh;
  server = https.createServer({ key, cert }, handler);
} else {
  server = http.createServer(handler);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') fail(`port ${opts.port} is already in use. Try --port ${opts.port + 1}.`);
  if (err.code === 'EACCES') fail(`not allowed to listen on port ${opts.port}. Try a port above 1024.`);
  fail(err.message);
});

server.listen(opts.port, '0.0.0.0', () => {
  const port = server.address().port;
  console.log(`\nDJ Mobile is being served from ${ROOT}\n`);
  console.log(`  Local:    ${scheme}://localhost:${port}/`);
  for (const ip of ips) console.log(`  Network:  ${scheme}://${ip}:${port}/`);
  if (!ips.length) console.log('  Network:  (no LAN address found)');
  if (opts.https) {
    console.log(`\n  Certificate: self-signed (${path.relative(ROOT, CERT_DIR)}/${freshCert ? ', just generated' : ', reused'}).`);
    console.log('  Your browser will warn that the connection is not private. That is expected:');
    console.log('  on the phone choose "Show details" / "Advanced" and then "visit this website" / "Proceed".');
  } else {
    console.log('\n  Plain http works on this machine (localhost). A phone on your network needs a secure');
    console.log('  page for audio: restart with --https and open the Network https:// address.');
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
