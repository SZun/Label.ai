import { expect, it } from 'vitest';
import { browsingModelLabel, playbackWindowLabel } from '../src/core/model-label';

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

it('requires strong, moving, distributed evidence for the current playback window', () => {
  const temporal = {
    eligible: true,
    sustainedFrameEvidence: true,
    motionEnergy: 0.02,
    sceneCuts: 0,
  };
  const result = { status: 'COMPLETED' as const, rawScore: 0.8, temporal };
  expect(playbackWindowLabel(result)).toBe(true);
  expect(playbackWindowLabel({ ...result, rawScore: 0.2 })).toBe(false);
  for (const change of [
    { eligible: false },
    { motionEnergy: 0 },
    { sceneCuts: 1 },
    { sustainedFrameEvidence: false },
  ]) {
    expect(playbackWindowLabel({ ...result, temporal: { ...temporal, ...change } })).toBe(false);
  }
});

it('retains the browsing video operating point for sustained distributed evidence in one moving scene', () => {
  const result = {
    status: 'COMPLETED' as const,
    rawScore: 0.1,
    temporal: {
      eligible: false,
      sceneCuts: 0,
      sustainedFrameEvidence: true,
      motionEnergy: 0.012,
      reasonCodes: ['MIXED_FRAME_EVIDENCE'],
    },
  };
  expect(playbackWindowLabel(result)).toBe(true);
  expect(playbackWindowLabel({ ...result, rawScore: 0.099 })).toBe(false);
  for (const changed of [
    { sustainedFrameEvidence: false },
    { sceneCuts: 1 },
    { motionEnergy: 0.009 },
    { reasonCodes: ['MIXED_FRAME_EVIDENCE', 'INSUFFICIENT_TEMPORAL_COVERAGE'] },
  ])
    expect(playbackWindowLabel({ ...result, temporal: { ...result.temporal, ...changed } })).toBe(
      false,
    );
});
