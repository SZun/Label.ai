import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

// Original Label.ai geometric artwork. No font, emoji, or third-party art is embedded.
export const ICON_SIZES = [16, 32, 48, 128, 256, 512, 1024] as const;
export const ICON_PATHS = Object.fromEntries(
  ICON_SIZES.map((size) => [String(size), `icons/icon-${size}.png`]),
);

type Point = readonly [number, number];
type Color = readonly [number, number, number];
const WHITE: Color = [255, 255, 255];
const RED: Color = [183, 28, 28];
const TAG: readonly Point[] = [
  [220, 250],
  [602, 250],
  [836, 484],
  [836, 540],
  [602, 774],
  [220, 774],
  [168, 722],
  [168, 302],
];
const INNER: readonly Point[] = [
  [240, 290],
  [586, 290],
  [795, 499],
  [795, 525],
  [586, 734],
  [240, 734],
  [208, 702],
  [208, 322],
];
const A: readonly Point[] = [
  [272, 650],
  [354, 374],
  [414, 374],
  [496, 650],
  [430, 650],
  [414, 590],
  [354, 590],
  [338, 650],
];
const COUNTER: readonly Point[] = [
  [369, 535],
  [399, 535],
  [384, 470],
];

function inside(x: number, y: number, points: readonly Point[]): boolean {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]!;
    const [xj, yj] = points[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) result = !result;
  }
  return result;
}

function colorAt(x: number, y: number): Color {
  const background = 39 - (y / 1024) * 14;
  if (x < 168 || x > 836 || y < 250 || y > 774 || !inside(x, y, TAG))
    return [background, background, background];
  if (!inside(x, y, INNER)) return WHITE;
  if ((x - 710) ** 2 + (y - 512) ** 2 <= 32 ** 2) return WHITE;
  if (x >= 536 && x <= 592 && y >= 374 && y <= 650) return WHITE;
  if (inside(x, y, A) && !inside(x, y, COUNTER)) return WHITE;
  return RED;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  const chunk = Buffer.alloc(body.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4);
  return chunk;
}

/** Dependency-free opaque PNG, supersampled from the same original geometry at
 * every size. Build-time only: no drawing library or generator ships at runtime.
 */
export function renderIconPng(size: number): Buffer {
  if (!Number.isInteger(size) || size < 16 || size > 1024)
    throw new RangeError('Unsupported icon size');
  const samples = size <= 128 ? 4 : 2;
  const pixels = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let red = 0,
        green = 0,
        blue = 0;
      for (let sy = 0; sy < samples; sy++)
        for (let sx = 0; sx < samples; sx++) {
          const color = colorAt(
            ((x + (sx + 0.5) / samples) / size) * 1024,
            ((y + (sy + 0.5) / samples) / size) * 1024,
          );
          red += color[0];
          green += color[1];
          blue += color[2];
        }
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      pixels[offset] = Math.round(red / samples ** 2);
      pixels[offset + 1] = Math.round(green / samples ** 2);
      pixels[offset + 2] = Math.round(blue / samples ** 2);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2; // RGB, deliberately opaque for Apple's app icon catalog.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function writeIcons(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const size of ICON_SIZES)
    await writeFile(join(directory, `icon-${size}.png`), renderIconPng(size));
}
