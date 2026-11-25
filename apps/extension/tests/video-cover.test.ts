import { expect, it, vi } from 'vitest';
import { playingVideoCovers } from '../src/media/video-cover';

it('suppresses the image badge on cover art behind a playing video, including under its controls', () => {
  const image = document.createElement('img'),
    video = document.createElement('video'),
    controls = document.createElement('div');
  vi.spyOn(video, 'paused', 'get').mockReturnValue(false);
  const rect = new DOMRect(0, 0, 300, 200);
  expect(playingVideoCovers(image, rect, () => [controls, video, image])).toBe(true);
  expect(playingVideoCovers(image, rect, () => [image, video])).toBe(false);
  expect(playingVideoCovers(image, rect, (x) => (x < 100 ? [video, image] : [image]))).toBe(false);
});
