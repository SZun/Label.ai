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
