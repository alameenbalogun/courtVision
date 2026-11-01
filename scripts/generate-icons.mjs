// Generates the PWA raster icons from a tiny PNG encoder (no image dependencies).
// Run with: node scripts/generate-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [10, 15, 10];
const LIME = [198, 255, 61];

const inRect = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
const nearRectEdge = (x, y, x0, y0, x1, y1, t) =>
  inRect(x, y, x0, y0, x1, y1) &&
  !inRect(x, y, x0 + t, y0 + t, x1 - t, y1 - t);

function drawIcon(x, y, size) {
  const u = size / 512;
  const pad = 70 * u;
  const edge = 20 * u;
  const t = 14 * u;

  if (nearRectEdge(x, y, pad, pad, size - pad, size - pad, t)) return LIME;
  if (nearRectEdge(x, y, 140 * u, 150 * u, size - 140 * u, 362 * u, 8 * u)) return [150, 200, 50];

  // Net line.
  if (inRect(x, y, pad, 256 * u - t / 2, size - pad, 256 * u + t / 2)) return LIME;

  // Centre service line (vertical, faint).
  if (inRect(x, y, 256 * u - 5 * u, pad, 256 * u + 5 * u, size - pad)) return [120, 160, 45];

  // Ball.
  const bx = 330 * u;
  const by = 182 * u;
  const br = 28 * u;
  if ((x - bx) ** 2 + (y - by) ** 2 <= br * br) return LIME;

  return BG;
}

for (const size of [192, 512]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, png(size, (x, y) => drawIcon(x, y, size)));
  console.log(`wrote ${file}`);
}
