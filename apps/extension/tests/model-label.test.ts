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
