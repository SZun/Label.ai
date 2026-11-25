/** Developer-only candidate evaluation. No API here is bundled in the extension. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { MODEL } from '../src/model.ts';
import { PREPROCESSING_VERSION } from '../src/preprocess.ts';
import { TEMPORAL_FEATURE_VERSION } from '../src/temporal.ts';
import { DEFAULT_POLICY, scoreImage, scoreVideo, type LocalPolicy } from '../src/policy.ts';
import type { LocalResult } from '../src/engine.ts';

export function candidatePolicy(artifact: unknown, manifestSha: string, artifactSha: string) {
  const value = artifact as {
    schema_version?: number; modality?: string; model_sha256?: string; preprocessing_version?: string;
    threshold?: number; holdout_manifest_sha256?: string; release_approved?: boolean;
    calibration?: LocalPolicy['image']['calibration'] | LocalPolicy['video']['calibration'];
  } | null;
  if (!value || value.schema_version !== 1 || (value.modality !== 'image' && value.modality !== 'video') ||
      value.model_sha256 !== MODEL.sha256 || value.preprocessing_version !== PREPROCESSING_VERSION ||
      value.holdout_manifest_sha256 !== manifestSha || value.release_approved !== false ||
      typeof value.threshold !== 'number' || !Number.isFinite(value.threshold) ||
      value.threshold < 0.5 || value.threshold > 1 || !value.calibration ||
      !/^[a-f0-9]{64}$/.test(artifactSha) || !/^[a-f0-9]{64}$/.test(manifestSha) ||
      value.calibration.calibrationSetSha256 === manifestSha) {
    throw new Error('Candidate must bind an unapproved frozen calibration, threshold, runtime and distinct holdout');
  }
  const policy: LocalPolicy = structuredClone(DEFAULT_POLICY);
  policy.version = 'candidate-' + artifactSha;
  if (value.modality === 'image') {
    const calibration = value.calibration as NonNullable<LocalPolicy['image']['calibration']>;
    scoreImage(0, calibration); // Real runtime validation.
    policy.image = { enabled: false, threshold: value.threshold, calibration };
  } else {
    const calibration = value.calibration as NonNullable<LocalPolicy['video']['calibration']>;
    scoreVideo({ meanLogit: 0, lowerQuartileLogit: 0, logitStd: 0, logitTemporalDelta: 0,
      motionEnergy: 0, secondOrderResidual: 0, sceneCuts: 0, coverage: 1, eligible: true, sustainedFrameEvidence: false,
      denseTriplets: 10, scoreQuantile25: .5, reasonCodes: [], frameCount: 12, sampleSpanMs: 5000 }, calibration);
    if (calibration.featureVersion !== TEMPORAL_FEATURE_VERSION) throw new Error('Mismatched temporal feature version');
    policy.video = { enabled: false, threshold: value.threshold, calibration };
  }
  return { policy, modality: value.modality };
}

export function candidateDecision(result: LocalResult, modality: 'image' | 'video', threshold: number) {
  if (result.status === 'UNSUPPORTED') return 'unsupported';
  if (result.status !== 'COMPLETED') return 'failed';
  const eligible = modality === 'image' || result.temporal?.eligible;
  return eligible && typeof result.score === 'number' && Number.isFinite(result.score) && result.score >= threshold
    ? 'label'
    : 'abstain';
}

/** A missing input makes the run invalid, not a correct negative prediction. */
export async function verifyCorpusAsset(manifest: string, file: string, sha256: string): Promise<string> {
  const base = await realpath(dirname(manifest));
  const path = await realpath(resolve(base, file));
  const rel = relative(base, path);
  const info = await stat(path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !info.isFile()) throw new Error('Corpus asset outside its manifest directory');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== sha256) throw new Error('Corpus asset checksum mismatch: ' + file);
  return path;
}
