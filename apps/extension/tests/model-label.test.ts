import { expect, it } from 'vitest';
import { browsingModelLabel } from '../src/core/model-label';

it('uses the ordinary image score boundary', () => {
  expect(browsingModelLabel('image', { status: 'COMPLETED', rawScore: 0.1 })).toBe(true);
  expect(browsingModelLabel('image', { status: 'COMPLETED', rawScore: 0.09999 })).toBe(false);
});

it('requires eligible temporal evidence and a high lower-quartile video score', () => {
  const score = (rawScore: number, eligible: boolean) =>
    browsingModelLabel('video', { status: 'COMPLETED', rawScore, temporal: { eligible } });
  expect(score(0.65, true)).toBe(true);
  expect(score(0.64999, true)).toBe(false);
  expect(score(0.9999, false)).toBe(false);
  expect(browsingModelLabel('video', { status: 'COMPLETED', rawScore: 0.9999 })).toBe(false);
});

it('abstains on invalid scores and incomplete results', () => {
  for (const rawScore of [undefined, NaN, Infinity, -1, 1.01])
    expect(browsingModelLabel('image', { status: 'COMPLETED', rawScore })).toBe(false);
  for (const status of ['FAILED', 'CANCELED', 'UNSUPPORTED'] as const)
    expect(browsingModelLabel('image', { status, rawScore: 0.99 })).toBe(false);
});

it('labels a moving clip with time-distributed evidence despite a weak frame, preserving structural vetoes', () => {
  const temporal = {
    eligible: false,
    sustainedFrameEvidence: true,
    motionEnergy: 0.035,
    reasonCodes: ['MIXED_FRAME_EVIDENCE'],
  };
  const result = { status: 'COMPLETED' as const, rawScore: 0.1, temporal };
  expect(browsingModelLabel('video', result)).toBe(true);
  expect(browsingModelLabel('video', { ...result, rawScore: 0.099 })).toBe(false);
  expect(
    browsingModelLabel('video', { ...result, temporal: { ...temporal, motionEnergy: 0.009 } }),
  ).toBe(false);
  expect(
    browsingModelLabel('video', {
      ...result,
      temporal: { ...temporal, sustainedFrameEvidence: false },
    }),
  ).toBe(false);
  for (const reason of [
    'INSUFFICIENT_TEMPORAL_COVERAGE',
    'EXCESSIVE_SCENE_DISCONTINUITY',
    'NO_TEMPORAL_CHANGE',
  ]) {
    expect(
      browsingModelLabel('video', {
        ...result,
        temporal: { ...temporal, reasonCodes: [...temporal.reasonCodes, reason] },
      }),
    ).toBe(false);
  }
});
