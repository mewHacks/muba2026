// Writes the toolbar icons. A solid SHOU-red rounded square is enough to
// find the extension in a toolbar, and generating it keeps three binary
// files out of the repo.
//
// Hand-rolled PNG encoder: a single IDAT chunk of raw RGBA scanlines at
// zlib level 9. Pulling in a PNG library for three flat squares would be
// a dependency for nothing.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function png(size) {
  const [r, g, b] = [0xb3, 0x26, 0x1e]; // --bad, the colour of a red flag
  const radius = Math.round(size * 0.22);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // leading filter byte, 0 = none
    for (let x = 0; x < size; x++) {
      // Rounded corners: transparent outside the corner arc.
      const dx = x < radius ? radius - x : x >= size - radius ? x - (size - radius - 1) : 0;
      const dy = y < radius ? radius - y : y >= size - radius ? y - (size - radius - 1) : 0;
      const outside = dx && dy && dx * dx + dy * dy > radius * radius;
      const at = 1 + x * 4;
      row[at] = r;
      row[at + 1] = g;
      row[at + 2] = b;
      row[at + 3] = outside ? 0 : 255;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  writeFileSync(join(HERE, 'icons', `${size}.png`), png(size));
}
console.log('wrote icons/16.png, icons/48.png, icons/128.png');
