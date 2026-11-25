import type { LocalResult } from '@label-ai/detector';

export type ModelEvidence = Pick<LocalResult, 'status' | 'rawScore'> & {
  temporal?: Pick<NonNullable<LocalResult['temporal']>, 'eligible'> &
    Partial<
      Pick<
        NonNullable<LocalResult['temporal']>,
        'sceneCuts' | 'motionEnergy' | 'reasonCodes' | 'sustainedFrameEvidence'
      >
    >;
};

export const BROWSING_MODEL_POLICY_VERSION = 'browsing-model-estimate-v3';

// Raw model operating points for display. Video scores summarize multiple frames.
const BROWSING_IMAGE_THRESHOLD = 0.1;
const BROWSING_VIDEO_THRESHOLD = 0.65;

export function meetsModelThreshold(
  kind: 'image' | 'video',
  result: ModelEvidence,
  threshold: number,
): boolean {
  return validScore(result, threshold) && (kind === 'image' || result.temporal?.eligible === true);
}

function validScore(result: ModelEvidence, threshold: number): boolean {
  const score = result.rawScore;
  return (
    result.status === 'COMPLETED' &&
    typeof score === 'number' &&
    Number.isFinite(score) &&
    score >= threshold &&
    score <= 1
  );
}

export function browsingModelLabel(kind: 'image' | 'video', result: ModelEvidence): boolean {
  if (kind === 'image') return meetsModelThreshold(kind, result, BROWSING_IMAGE_THRESHOLD);
  if (meetsModelThreshold('video', result, BROWSING_VIDEO_THRESHOLD)) return true;
  const evidence = result.temporal;
  return (
    evidence?.sustainedFrameEvidence === true &&
    (evidence.motionEnergy ?? 0) >= 0.01 &&
    evidence.reasonCodes?.every((reason) => reason === 'MIXED_FRAME_EVIDENCE') === true &&
    validScore(result, 0.1)
  );
}

export function playbackWindowLabel(result: ModelEvidence): boolean {
  return (
    meetsModelThreshold('video', result, BROWSING_VIDEO_THRESHOLD) &&
    result.temporal?.sustainedFrameEvidence === true &&
    result.temporal.sceneCuts === 0 &&
    (result.temporal.motionEnergy ?? 0) >= 0.01
  );
}
