#!/usr/bin/env node
// Draws the LTM toolbar icons procedurally and writes them as PNGs (no third-party
// artwork, no image libraries): a rounded square with three "sound level" bars.
// `idle-*` is indigo; `rec-*` is red with a white record dot, so the recording state is
// recognisable by shape as well as colour.
//
// Usage: node scripts/icons.mjs   (writes public/icons/{idle,rec}-{16,32,48,128}.png)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/icons");
const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling per axis

const VARIANTS = {
  idle: { bg: [43, 58, 103], fg: [255, 255, 255], dot: false },
  rec: { bg: [217, 48, 37], fg: [255, 255, 255], dot: true },
};

// Shapes in a unit square (0..1). Signed distance functions: < 0 inside.
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}
function sdCircle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r;
}

function shade(variant, x, y) {
  // returns [r,g,b,a] in 0..1 alpha
  const v = VARIANTS[variant];
  const inBg = sdRoundRect(x, y, 0.5, 0.5, 0.48, 0.48, 0.2) < 0;
  if (!inBg) return null;
  // Bars: centred, rounded ends ("capsules").
  const bars = v.dot
    ? [
        [0.3, 0.2],
        [0.48, 0.3],
        [0.66, 0.16],
      ]
    : [
        [0.3, 0.18],
        [0.5, 0.3],
        [0.7, 0.14],
      ];
  const barHalfW = 0.065;
  for (const [cx, hh] of bars) {
    if (sdRoundRect(x, y, cx, v.dot ? 0.56 : 0.5, barHalfW, hh, barHalfW) < 0) return v.fg;
  }
  if (v.dot && sdCircle(x, y, 0.76, 0.24, 0.11) < 0) return v.fg;
  return v.bg;
}

function render(variant, size) {
  const px = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxl + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const c = shade(variant, x, y);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + pxl) * 4;
      const n = SS * SS;
      if (a > 0) {
        // Colour is averaged over covered samples only (straight alpha, no dark fringes).
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const variant of Object.keys(VARIANTS)) {
  for (const size of SIZES) {
    const file = resolve(outDir, `${variant}-${size}.png`);
    writeFileSync(file, png(size, render(variant, size)));
    console.log("wrote", file);
  }
}
