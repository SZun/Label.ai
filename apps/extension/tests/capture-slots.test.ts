import { expect, it } from 'vitest';
import { CaptureSlots } from '../src/core/capture-slots';

it('bounds aggregate live video captures, including queued inference, and releases canceled owners', () => {
  const slots = new CaptureSlots(1);
  expect(slots.acquire('first')).toBe(true);
  for (let i = 0; i < 200; i++) expect(slots.acquire(`overlapping-${i}`)).toBe(false);
  slots.release('unrelated');
  expect(slots.acquire('next')).toBe(false);
  slots.release('first');
  expect(slots.acquire('next')).toBe(true);
  slots.release('first');
  expect(slots.acquire('another')).toBe(false);
  slots.release('next');
  expect(slots.acquire('another')).toBe(true);
});
