#!/usr/bin/env node
// Draws the LTM app icons procedurally and writes them as PNGs (no third-party artwork, no
// image libraries): a cream "L" on the ink-green notebook square, with a small coral dot —
// the recording indicator used throughout the app.
//
// Usage: node scripts/icons.mjs   (writes public/icons/*.png; the outputs are committed)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/icons");
const SS = 4; // supersampling per axis

const BG = [47, 95, 87];
const FG = [245, 241, 232];
const DOT = [224, 122, 95];

function sdRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = Math.abs(x - cx) - (x1 - x0) / 2 + r;
  const qy = Math.abs(y - cy) - (y1 - y0) / 2 + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

/** Colour at unit coordinates; `scale` shrinks the mark towards the centre (maskable safe zone). */
function sample(x, y, { rounded, scale }) {
  const inBg = rounded ? sdRoundRect(x, y, 0, 0, 1, 1, 0.22) < 0 : true;
  if (!inBg) return null;
  const mx = (x - 0.5) / scale + 0.5;
  const my = (y - 0.5) / scale + 0.5;
  const l =
    Math.min(
      sdRoundRect(mx, my, 0.29, 0.22, 0.42, 0.78, 0.035),
      sdRoundRect(mx, my, 0.29, 0.65, 0.71, 0.78, 0.035),
    ) < 0;
  if (l) return FG;
  if (sdCircle(mx, my, 0.66, 0.33, 0.08) < 0) return DOT;
  return BG;
}

function render(size, opts) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxx = 0; pxx < size; pxx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxx + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + pxx) * 4;
      const n = SS * SS;
      px[i] = a ? Math.round(r / a) : 0;
      px[i + 1] = a ? Math.round(g / a) : 0;
      px[i + 2] = a ? Math.round(b / a) : 0;
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return png(size, px);
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
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
const outputs = {
  "icon-192.png": render(192, { rounded: true, scale: 1 }),
  "icon-512.png": render(512, { rounded: true, scale: 1 }),
  // Maskable: full bleed, mark inside the 80 % safe circle so any mask shape keeps it whole.
  "maskable-512.png": render(512, { rounded: false, scale: 0.72 }),
  "maskable-192.png": render(192, { rounded: false, scale: 0.72 }),
  // iOS rounds the corners itself and ignores transparency.
  "apple-touch-icon.png": render(180, { rounded: false, scale: 0.86 }),
};
for (const [name, buf] of Object.entries(outputs)) writeFileSync(resolve(outDir, name), buf);
console.log(`wrote ${Object.keys(outputs).length} icons to ${outDir}`);
