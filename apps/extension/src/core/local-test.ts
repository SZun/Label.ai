import type { LocalResult } from '@label-ai/detector';

// WXT defines this constant explicitly in each build. The production bundle
// receives false; a webpage, setting or detector result cannot enable it.
declare const __LABEL_AI_LOCAL_TEST__: boolean;
export const LOCAL_TEST_BUILD =
  typeof __LABEL_AI_LOCAL_TEST__ !== 'undefined' && __LABEL_AI_LOCAL_TEST__;
export const LOCAL_TEST_POLICY_VERSION = 'local-test-raw-v1';
export const LOCAL_TEST_IMAGE_THRESHOLD = 0.1;
export const LOCAL_TEST_VIDEO_THRESHOLD = 0.2;

export function isLocalTestUrl(input: string | undefined): boolean {
  if (!input) return false;
  try {
    const url = new URL(input);
    return (
      url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      ['localhost', '127.0.0.1'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

type RawTestResult = Pick<LocalResult, 'status' | 'rawScore'> & {
  temporal?: Pick<NonNullable<LocalResult['temporal']>, 'eligible'>;
};

/** Exploratory labels only for a separately built and explicitly granted loopback page. */
export function localTestDecision(
  enabled: boolean,
  pageUrl: string | undefined,
  kind: 'image' | 'video',
  result: RawTestResult,
): boolean {
  const score = result.rawScore;
  if (
    !enabled ||
    !isLocalTestUrl(pageUrl) ||
    result.status !== 'COMPLETED' ||
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1
  )
    return false;
  return kind === 'image'
    ? score >= LOCAL_TEST_IMAGE_THRESHOLD
    : result.temporal?.eligible === true && score >= LOCAL_TEST_VIDEO_THRESHOLD;
}
