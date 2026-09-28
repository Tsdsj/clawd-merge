// Generates the PNG app icons (home screen / PWA) from pixel art.
// Zero dependencies: a minimal PNG encoder on top of node:zlib.
// Usage: node scripts/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

// Crowned Clawd on a 16×16 grid ('#' body, 'K' eyes, 'Y'/'y' crown, 'R'/'U' gems, 'P' blush).
const ART = [
  '................',
  '...Y...YY...Y...',
  '...YY.YYYY.YY...',
  '...YYYYYYYYYY...',
  '...yRyyUUyyRy...',
  '..############..',
  '..############..',
  '..###K####K###..',
  '#####K####K#####',
  '###PP######PP###',
  '..############..',
  '..############..',
  '..############..',
  '...#.#....#.#...',
  '...#.#....#.#...',
  '................',
];
const COLORS = {
  '#': [0xd9, 0x77, 0x57],
  K: [0x1b, 0x1a, 0x22],
  Y: [0xf7, 0xc9, 0x48],
  y: [0xd9, 0xa1, 0x2b],
  R: [0xe5, 0x48, 0x4d],
  U: [0x4d, 0x9d, 0xff],
  P: [0xf5, 0x9a, 0xb0],
};
const BG = [0x1a, 0x1b, 0x2e];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// `pad` is the fraction of the icon left as margin around the art (maskable icons need ~20%).
function icon(size, pad) {
  const cell = Math.floor((size * (1 - pad * 2)) / 16);
  const offset = Math.floor((size - cell * 16) / 2);
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x - offset) / cell);
      const cy = Math.floor((y - offset) / cell);
      const ch = ART[cy]?.[cx];
      const rgb = COLORS[ch] ?? BG;
      raw.set(rgb, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../icons/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('apple-touch-icon.png', dir), icon(180, 0.1));
writeFileSync(new URL('icon-192.png', dir), icon(192, 0.1));
writeFileSync(new URL('icon-512.png', dir), icon(512, 0.1));
writeFileSync(new URL('icon-maskable-512.png', dir), icon(512, 0.2));
console.log('icons written to icons/');
