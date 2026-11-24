// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { ICON_PATHS, ICON_SIZES, renderIconPng, writeIcons } from '../icon-assets';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('ICON-01 emits valid opaque PNG dimensions at browser and Apple icon sizes', () => {
  expect(ICON_SIZES).toContain(512);
  expect(ICON_SIZES).toContain(1024);
  for (const size of ICON_SIZES) {
    const png = renderIconPng(size);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(2); // RGB: no transparent pixels in the native app source icon.
    const imageBytes = png.readUInt32BE(33);
    expect(png.toString('ascii', 37, 41)).toBe('IDAT');
    const pixels = inflateSync(png.subarray(41, 41 + imageBytes));
    expect(pixels.length).toBe(size * (size * 3 + 1));
    expect(new Set(pixels).size).toBeGreaterThan(10);
  }
});

it('ICON-02 writes every manifest resource reproducibly without external assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'label-ai-icons-'));
  temporary.push(directory);
  await writeIcons(directory);
  for (const size of ICON_SIZES) {
    const filename = ICON_PATHS[String(size)]!;
    expect(filename).toBe(`icons/icon-${size}.png`);
    expect(await readFile(join(directory, `icon-${size}.png`))).toEqual(renderIconPng(size));
  }
  expect(() => renderIconPng(0)).toThrow();
  expect(() => renderIconPng(4096)).toThrow();
});
