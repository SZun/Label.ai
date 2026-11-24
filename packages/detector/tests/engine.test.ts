import assert from 'node:assert/strict';
import test from 'node:test';
import { createDetectorEngine, type InferenceRunner } from '../src/engine.ts';

const rgbaInput = () => ({ rgba: new Uint8Array(128 * 128 * 4).fill(255), width: 128, height: 128 });

test('DET-RUN-01 performs actual input-dependent runner calls but fails closed without validation', async () => {
  let calls = 0;
  const engine = createDetectorEngine({ run: async tensor => { calls++; return tensor[0]!; }, dispose: async () => {} });
  const result = await engine.analyzeRgba(rgbaInput());
  assert.equal(calls, 1);
  assert.equal(result.status, 'COMPLETED');
  assert.ok(result.score! > 0.5);
  assert.equal(result.shouldLabel, false);
  assert.ok(result.reasonCodes.includes('IMAGE_ROUTE_UNVALIDATED'));
  await engine.dispose();
});

test('DET-RUN-02 rejects a canceled result even if the native computation finishes', async () => {
  const controller = new AbortController();
  const runner: InferenceRunner = { run: async () => { controller.abort(); return 8; }, dispose: async () => {} };
  const engine = createDetectorEngine(runner);
  const result = await engine.analyzeRgba({ ...rgbaInput(), signal: controller.signal });
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.shouldLabel, false);
  assert.equal(result.score, undefined);
});

test('DET-RUN-03 serializes session use and releases exactly once', async () => {
  let active = 0, maximum = 0, disposed = 0;
  const engine = createDetectorEngine({
    run: async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return 0; },
    dispose: async () => { disposed++; },
  });
  await Promise.all([engine.analyzeRgba(rgbaInput()), engine.analyzeRgba(rgbaInput())]);
  assert.equal(maximum, 1);
  await engine.dispose();
  await engine.dispose();
  assert.equal(disposed, 1);
  assert.equal((await engine.analyzeRgba(rgbaInput())).status, 'FAILED');
});

test('DET-RUN-04 no filename, metadata claim, malformed input, or model error can become a label', async () => {
  const engine = createDetectorEngine({ run: async () => { throw new Error('native failure'); }, dispose: async () => {} });
  assert.equal((await engine.analyzeRgba(rgbaInput())).status, 'FAILED');
  const bad = await engine.analyzeRgba({ rgba: new Uint8Array(4), width: 1, height: 1 });
  assert.equal(bad.status, 'UNSUPPORTED');
  assert.equal(bad.shouldLabel, false);
});

test('VID-RUN-05 yields between native calls so cancellation can stop the remaining frames', async () => {
  const controller = new AbortController();
  let calls = 0;
  const engine = createDetectorEngine({
    run: async () => { calls++; if (calls === 1) setTimeout(() => controller.abort(), 0); return 4; },
    dispose: async () => {},
  });
  const frames = Array.from({ length: 12 }, (_, index) => {
    const rgba = new Uint8Array(128 * 128 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([50 + index * 4, 50, 50, 255], i);
    return { rgba, width: 128, height: 128, timestampMs: index * 500 };
  });
  const result = await engine.analyzeVideoFrames({ frames, durationMs: 5500, signal: controller.signal });
  assert.equal(result.status, 'CANCELED');
  assert.equal(result.shouldLabel, false);
  assert.equal(calls, 1, 'queued frame inference must stop at the next yield');
});
