import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectBoundedPng } from '../src/encoding.ts';

function png(width: number, height: number, animated = false): Uint8Array {
  const values: number[] = [137, 80, 78, 71, 13, 10, 26, 10];
  function chunk(name: string, data: number[]) {
    const size = data.length;
    values.push(size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255,
      ...[...name].map(char => char.charCodeAt(0)), ...data, 0, 0, 0, 0);
  }
  const w = new Uint8Array(8); const view = new DataView(w.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  chunk('IHDR', [...w, 8, 6, 0, 0, 0]);
  if (animated) chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]);
  chunk('IDAT', [0]);
  chunk('IEND', []);
  return new Uint8Array(values);
}

test('DET-DECODE-01 inspect dimensions before native image allocation', () => {
  assert.deepEqual(inspectBoundedPng(png(640, 480)), { width: 640, height: 480 });
  assert.throws(() => inspectBoundedPng(png(100000, 100000)), /dimensions/i);
  assert.throws(() => inspectBoundedPng(png(127, 127)), /dimensions/i);
});

test('DET-DECODE-02 animated and malformed containers cannot be treated as still images', () => {
  assert.throws(() => inspectBoundedPng(png(640, 480, true)), /animated/i);
  assert.throws(() => inspectBoundedPng(new Uint8Array(80)), /PNG/i);
  assert.throws(() => inspectBoundedPng(png(640, 480).slice(0, 35)), /PNG/i);
});
