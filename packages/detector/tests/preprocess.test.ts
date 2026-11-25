import assert from 'node:assert/strict';
import test from 'node:test';
import { INPUT_SIZE, preprocessRgba, sigmoid } from '../src/preprocess.ts';

function solid(r: number, g: number, b: number, alpha = 255) {
  const rgba = new Uint8Array(128 * 128 * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([r, g, b, alpha], i);
  return { rgba, width: 128, height: 128 };
}

test('DET-PRE-01 normalizes real RGBA values into planar model input', () => {
  const tensor = preprocessRgba(solid(255, 0, 0));
  assert.equal(tensor.length, 3 * INPUT_SIZE * INPUT_SIZE);
  const n = INPUT_SIZE * INPUT_SIZE;
  assert.ok(Math.abs(tensor[0]! - (1 - 0.485) / 0.229) < 1e-5);
  assert.ok(Math.abs(tensor[n]! + 0.456 / 0.224) < 1e-5);
  assert.ok(Math.abs(tensor[2 * n]! + 0.406 / 0.225) < 1e-5);
  assert.equal(tensor[0], tensor[n - 1]);
});

test('DET-PRE-02 alpha is composited against a fixed white background', () => {
  assert.deepEqual(preprocessRgba(solid(123, 20, 43, 0)), preprocessRgba(solid(255, 255, 255)));
});

test('DET-PRE-03 aspect ratio is preserved before center crop', () => {
  const rgba = new Uint8Array(768 * 384 * 4);
  for (let y = 0; y < 384; y++) for (let x = 0; x < 768; x++) {
    rgba.set(x >= 192 && x < 576 ? [255, 0, 0, 255] : [0, 255, 0, 255], (y * 768 + x) * 4);
  }
  const tensor = preprocessRgba({ rgba, width: 768, height: 384 });
  const n = INPUT_SIZE * INPUT_SIZE;
  assert.ok(tensor[0]! > 2, 'center crop should exclude the side bars');
  assert.ok(tensor[n - 1]! > 2);
});

test('DET-PRE-04 rejects inconsistent, tiny, oversized, or canceled input', () => {
  for (const input of [
    { rgba: new Uint8Array(4), width: 128, height: 128 },
    { rgba: new Uint8Array(16), width: 2, height: 2 },
    { rgba: new Uint8Array(4), width: 100000, height: 100000 },
    { rgba: new Uint8Array(4), width: NaN, height: 128 },
  ]) assert.throws(() => preprocessRgba(input), /input|dimensions|size/i);
  const signal = AbortSignal.abort();
  assert.throws(() => preprocessRgba({ ...solid(0, 0, 0), signal }), /abort/i);
});

test('DET-PRE-05 sigmoid is stable and rejects nonfinite inference', () => {
  assert.equal(sigmoid(0), 0.5);
  assert.equal(sigmoid(1000), 1);
  assert.equal(sigmoid(-1000), 0);
  assert.throws(() => sigmoid(NaN), /finite/i);
});
