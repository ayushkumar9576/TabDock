// Generate the small code-drawn parking mark as PNGs; no packages or AI artwork needed.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
const table = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, data) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([name, data])) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, name, data, checksum]);
}
mkdirSync(new URL("../icons/", import.meta.url), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) / size; const py = (y + .5) / size;
    const cx = Math.max(.22, Math.min(.78, px)); const cy = Math.max(.22, Math.min(.78, py));
    const inside = Math.hypot(px - cx, py - cy) < .18;
    const stem = px > .32 && px < .43 && py > .24 && py < .78;
    const bowl = px > .38 && px < .69 && py > .24 && py < .57;
    const hole = px > .43 && px < .58 && py > .35 && py < .46;
    const white = stem || (bowl && !hole);
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    pixels.set(white ? [23, 19, 15, inside ? 255 : 0] : [228, 87, 46, inside ? 255 : 0], offset);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  writeFileSync(new URL(`../icons/icon${size}.png`, import.meta.url), png);
}
console.log("Generated 16, 32, 48, and 128 px extension icons.");
