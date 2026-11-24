import type { LocalResult } from '@label-ai/detector';

export type ModelEvidence = Pick<LocalResult, 'status' | 'rawScore'> & {
  temporal?: Pick<NonNullable<LocalResult['temporal']>, 'eligible'>;
};

export const BROWSING_MODEL_POLICY_VERSION = 'browsing-model-estimate-v1';

// This uncalibrated operating point is recorded in ml/reports/frontier-dev-2026-10.json.
// It is a cutoff for displaying estimates, not a probability or validated accuracy claim.
const BROWSING_MODEL_THRESHOLD = 0.65;

export function meetsModelThreshold(
  kind: 'image' | 'video',
  result: ModelEvidence,
  threshold: number,
): boolean {
  const score = result.rawScore;
  return (
    result.status === 'COMPLETED' &&
    typeof score === 'number' &&
    Number.isFinite(score) &&
    score >= threshold &&
    score <= 1 &&
    (kind === 'image' || result.temporal?.eligible === true)
  );
}

export function browsingModelLabel(kind: 'image' | 'video', result: ModelEvidence): boolean {
  return meetsModelThreshold(kind, result, BROWSING_MODEL_THRESHOLD);
}
