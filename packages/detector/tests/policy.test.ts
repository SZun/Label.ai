import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL } from '../src/model.ts';
import { PREPROCESSING_VERSION } from '../src/preprocess.ts';
import { approveRoute, DEFAULT_POLICY, scoreImage, type LocalPolicy } from '../src/policy.ts';

function reviewedPolicy(): LocalPolicy {
  return {
    version: 'test-only-reviewed-policy',
    image: {
      enabled: true,
      threshold: 0.99,
      calibration: { version: 'test-platt-v1', slope: 1.1, intercept: -0.5, calibrationSetSha256: 'c'.repeat(64) },
      evidence: { approved: true, evaluationId: 'test-only', modelSha256: MODEL.sha256,
        preprocessingVersion: PREPROCESSING_VERSION, calibrationVersion: 'test-platt-v1', threshold: 0.99,
        manifestSha256: 'a'.repeat(64), predictionsSha256: 'b'.repeat(64),
        projectedPrecisionLower95: 0.995, fprUpper95: 0.00001, recall: 0.8 },
    },
    video: { enabled: false, threshold: 0.99 },
  };
}

test('DET-POL-01 a high score alone cannot authorize a label', () => {
  assert.equal(approveRoute(DEFAULT_POLICY, 'image'), false);
  assert.equal(approveRoute(DEFAULT_POLICY, 'video'), false);
  const policy = reviewedPolicy();
  delete policy.image.evidence;
  assert.equal(approveRoute(policy, 'image'), false);
});

test('DET-POL-02 approval binds model, preprocessing, calibration, threshold and quality', () => {
  const policy = reviewedPolicy();
  assert.equal(approveRoute(policy, 'image'), true);
  for (const [key, value] of [
    ['approved', false], ['modelSha256', 'wrong'], ['preprocessingVersion', 'wrong'],
    ['calibrationVersion', 'wrong'], ['threshold', 0.5], ['manifestSha256', 'c'.repeat(64)],
    ['projectedPrecisionLower95', 0.9], ['fprUpper95', 0.01], ['recall', 0.2],
  ] as const) {
    const changed = structuredClone(policy);
    Object.assign(changed.image.evidence!, { [key]: value });
    assert.equal(approveRoute(changed, 'image'), false, key);
  }
});

test('DET-CAL-01 Platt mapping is explicit, finite, and not called a certainty score', () => {
  assert.equal(scoreImage(0), 0.5);
  assert.ok(scoreImage(2, reviewedPolicy().image.calibration) > 0.8);
  assert.throws(() => scoreImage(2, { version: 'bad', slope: NaN, intercept: 0, calibrationSetSha256: 'a'.repeat(64) }), /calibration/i);
});

test('narrow image thumbnails provide preview evidence without inheriting calibrated approval', async () => {
  const { createDetectorEngine } = await import('../src/engine.ts');
  const engine = createDetectorEngine({ run: async () => 10, dispose: async () => {} }, reviewedPolicy());
  const pixels = (width: number, height: number) => ({ width, height, rgba: new Uint8Array(width * height * 4) });
  assert.equal((await engine.analyzeRgba(pixels(192, 128))).shouldLabel, true);
  for (const [width, height] of [[250, 125], [96, 192], [192, 96]] as const) {
    const result = await engine.analyzeRgba(pixels(width, height));
    assert.equal(result.status, 'COMPLETED');
    assert.ok(result.rawScore! > 0.99);
    assert.equal(result.shouldLabel, false);
    assert.equal(result.score, undefined);
    assert.ok(result.reasonCodes.includes('SCORE_UNCALIBRATED'));
  }
  for (const [width, height] of [[127, 127], [95, 250], [191, 96]] as const) {
    assert.equal((await engine.analyzeRgba(pixels(width, height))).status, 'UNSUPPORTED');
  }
  assert.equal((await engine.analyzeVideoFrames({
    frames: [{ ...pixels(250, 125), timestampMs: 0 }], durationMs: 1000,
  })).status, 'UNSUPPORTED');
  await engine.dispose();
});
