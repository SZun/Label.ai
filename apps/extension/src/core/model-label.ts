import type { LocalResult } from '@label-ai/detector';

export type ModelEvidence = Pick<LocalResult, 'status' | 'rawScore'> & {
  temporal?: Pick<NonNullable<LocalResult['temporal']>, 'eligible'>;
};

export const BROWSING_MODEL_POLICY_VERSION = 'browsing-model-estimate-v2';

// Raw model operating points for display. Video scores summarize multiple frames.
const BROWSING_IMAGE_THRESHOLD = 0.1;
const BROWSING_VIDEO_THRESHOLD = 0.65;

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
  const threshold = kind === 'image' ? BROWSING_IMAGE_THRESHOLD : BROWSING_VIDEO_THRESHOLD;
  return meetsModelThreshold(kind, result, threshold);
}
