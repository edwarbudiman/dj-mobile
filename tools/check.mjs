#!/usr/bin/env node
// Runs `node --check` on every .js/.mjs file under js/, tools/, tests/ plus sw.js (if present).
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];

function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(name)) files.push(p);
  }
}
for (const d of ['js', 'tools', 'tests']) walk(join(root, d));
if (existsSync(join(root, 'sw.js'))) files.push(join(root, 'sw.js'));

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    bad++;
    console.error(`FAIL ${f}\n${r.stderr}`);
  } else console.log(`ok   ${f.slice(root.length + 1)}`);
}
console.log(bad ? `${bad} file(s) failed` : `all ${files.length} files OK`);
process.exit(bad ? 1 : 0);
