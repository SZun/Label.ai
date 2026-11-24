import assert from 'node:assert/strict';
import test from 'node:test';
import { MODEL } from '../src/model.ts';
import { PREPROCESSING_VERSION } from '../src/preprocess.ts';
import { approveRoute } from '../src/policy.ts';
import { candidatePolicy, candidateDecision, verifyCorpusAsset } from './corpus-policy.ts';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { LocalResult } from '../src/engine.ts';

const digest = 'd'.repeat(64);
const fixture = {
  schema_version: 1, modality: 'image', model_sha256: MODEL.sha256,
  preprocessing_version: PREPROCESSING_VERSION, threshold: .99,
  holdout_manifest_sha256: digest, release_approved: false,
  calibration: { version: 'test-platt', slope: 1, intercept: 0, calibrationSetSha256: 'a'.repeat(64) },
};

test('DET-EVAL-01 candidate must match the frozen holdout and runtime and cannot activate extension labels', () => {
  const { policy, modality } = candidatePolicy(fixture, digest, 'b'.repeat(64));
  assert.equal(modality, 'image');
  assert.equal(policy.image.threshold, .99);
  assert.equal(approveRoute(policy, 'image'), false);
  assert.equal(approveRoute(policy, 'video'), false);
  for (const override of [
    { holdout_manifest_sha256: 'e'.repeat(64) }, { model_sha256: 'bad' },
    { preprocessing_version: 'bad' }, { release_approved: true }, { threshold: 0.2 },
    { calibration: { ...fixture.calibration, intercept: Infinity } },
  ]) assert.throws(() => candidatePolicy({ ...fixture, ...override }, digest, 'b'.repeat(64)));
});

function result(overrides: Partial<LocalResult> = {}): LocalResult {
  return { status: 'COMPLETED', shouldLabel: false, classification: 'UNCERTAIN',
    reasonCodes: [], modelVersion: MODEL.id, policyVersion: 'test', score: .999, ...overrides };
}

test('DET-EVAL-02 release prediction reflects score, status and full temporal eligibility', () => {
  assert.equal(candidateDecision(result(), 'image', .99), 'label');
  assert.equal(candidateDecision(result({ score: .5 }), 'image', .99), 'abstain');
  assert.equal(candidateDecision(result({ score: NaN }), 'image', .99), 'abstain');
  assert.equal(candidateDecision(result({ status: 'UNSUPPORTED' }), 'image', .99), 'unsupported');
  assert.equal(candidateDecision(result({ status: 'FAILED' }), 'image', .99), 'failed');
  assert.equal(candidateDecision(result({ status: 'CANCELED' }), 'image', .99), 'failed');
  assert.equal(candidateDecision(result(), 'video', .99), 'abstain');
});


test('DET-EVAL-03 a missing or tampered release asset cannot masquerade as an abstention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corpus-asset-test-'));
  try {
    const file = join(directory, 'fixture.jpg'), manifest = join(directory, 'manifest.jsonl');
    const bytes = Buffer.from('fixture bytes');
    const sha = createHash('sha256').update(bytes).digest('hex');
    await writeFile(file, bytes);
    assert.equal(await verifyCorpusAsset(manifest, 'fixture.jpg', sha), file);
    await assert.rejects(verifyCorpusAsset(manifest, 'fixture.jpg', '0'.repeat(64)));
    await assert.rejects(verifyCorpusAsset(manifest, 'absent.jpg', sha));
    await assert.rejects(verifyCorpusAsset(manifest, '../fixture.jpg', sha));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
