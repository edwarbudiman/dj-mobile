#!/usr/bin/env node
// Generates the app icons (icons/*.png) with no dependencies: a vinyl record in the app's palette
// (graphite plate, cyan and pink ring for the two decks, a pale position marker), rasterised by a small
// supersampling renderer and encoded as PNG with node:zlib.
//
//   node tools/make-icons.mjs
//
// Output: icons/icon-192.png, icon-512.png (purpose "any"), icon-maskable-192.png, icon-maskable-512.png
// (the mark sits inside the central 80 % safe zone, full-bleed background) and apple-touch-icon.png (180).
// Everything here is original artwork drawn from circles and arcs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const C = {
  ink: hex('#17181a'),
  plate: hex('#202124'),
  vinyl: hex('#0b0b0c'),
  label: hex('#25262a'),
  cyan: hex('#38d4ff'),
  pink: hex('#ff4f9a'),
  text: hex('#ece8df'),
};
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Colour at (u, v) in [-1, 1]^2 (v down). `mark` is the radius of the record as a fraction of the half-size.
 */
function shade(u, v, mark) {
  // background: graphite with a faint lift in the middle
  const rho0 = Math.hypot(u, v);
  let col = mix(C.plate, C.ink, Math.min(1, rho0 * 0.9));
  const r = Math.hypot(u, v) / mark; // 1 = rim of the record
  if (r > 1.0) return col;
  const theta = Math.atan2(v, u); // 0 = right, clockwise (v down)
  col = C.vinyl;
  // grooves
  if (r > 0.42 && r < 0.9) {
    const g = 0.5 + 0.5 * Math.cos(r * 150);
    col = mix(col, [255, 255, 255], 0.035 + 0.035 * g);
  }
  // deck ring: cyan on the upper-left half, pink on the lower-right, with small gaps where they meet
  if (r > 0.9) {
    const a = theta + Math.PI * 0.25; // rotate the split to run from lower-left to upper-right
    const gap = 0.07;
    const s = Math.sin(a);
    if (Math.abs(s) > gap) col = s < 0 ? C.cyan : C.pink;
    else col = C.ink;
  }
  // label
  if (r < 0.36) {
    col = C.label;
    if (r > 0.31) col = mix(C.label, C.cyan, 0.55);
  }
  // position marker: a bar from the label to the grooves, at -50 degrees, with a dot at the rim
  const ang = -Math.PI * 0.28;
  const ax = Math.cos(ang);
  const ay = Math.sin(ang);
  const along = u * ax + v * ay;
  const across = -u * ay + v * ax;
  const along_r = along / mark;
  if (along_r > 0.42 && along_r < 0.82 && Math.abs(across) / mark < 0.032) col = C.text;
  if (Math.hypot(along_r - 0.82, across / mark) < 0.075) col = C.text;
  // spindle
  if (r < 0.045) col = C.vinyl;
  return col;
}

function render(size, mark) {
  const SS = 3; // 3 x 3 samples per pixel
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / SS) / size) * 2 - 1;
          const c = shade(u, v, mark);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = 255;
    }
  }
  return px;
}

// ---- PNG encoder -----------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- main ------------------------------------------------------------------------------------

const ICONS = [
  ['icon-192.png', 192, 0.84],
  ['icon-512.png', 512, 0.84],
  ['icon-maskable-192.png', 192, 0.7], // maskable: everything inside the central 80 % circle
  ['icon-maskable-512.png', 512, 0.7],
  ['apple-touch-icon.png', 180, 0.82],
];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, size, mark] of ICONS) {
    const png = encodePng(size, render(size, mark));
    fs.writeFileSync(path.join(OUT, name), png);
    console.log(`icons/${name}  ${size}x${size}  ${png.length} bytes`);
  }
}
