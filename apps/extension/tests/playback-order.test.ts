import { expect, it } from 'vitest';
import { visiblePlaybackArea } from '../src/media/playback-order';

it('gives the centered feed player precedence over a nearly scrolled-away taller video', () => {
  const viewport = { width: 400, height: 700 };
  expect(visiblePlaybackArea(new DOMRect(0, -770, 390, 800), viewport)).toBe(390 * 30);
  expect(visiblePlaybackArea(new DOMRect(20, 40, 360, 620), viewport)).toBe(360 * 620);
  expect(visiblePlaybackArea(new DOMRect(450, 0, 360, 500), viewport)).toBe(0);
});
