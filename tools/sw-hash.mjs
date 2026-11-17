#!/usr/bin/env node
// The service worker's cache version is a hash of every file it precaches, so a changed file can never be
// served stale from an old cache: sw.js is byte-different whenever the app is, the browser installs the new
// worker, and the new worker fills a NEW cache (the old one stays until the new worker activates).
//
//   node tools/sw-hash.mjs      prints the version string sw.js must contain (tests/sw-precache.test.mjs fails
//                               while sw.js carries a different one; paste the printed line into sw.js)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every file the app shell consists of, as forward-slash paths relative to the project root, sorted. */
export function appShellFiles(root = ROOT) {
  const out = ['index.html', 'manifest.webmanifest'];
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
      const rel = `${dir}/${name}`;
      if (fs.statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (!name.startsWith('.')) out.push(rel);
    }
  };
  for (const dir of ['css', 'js', 'icons']) walk(dir);
  return out.sort();
}

/** First 10 hex chars of sha256 over (path, content) of every app shell file. */
export function shellHash(root = ROOT) {
  const h = crypto.createHash('sha256');
  for (const rel of appShellFiles(root)) {
    h.update(rel);
    h.update('\0');
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 10);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`const VERSION = '${shellHash()}';`);
}
