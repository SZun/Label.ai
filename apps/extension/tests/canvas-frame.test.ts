import { afterEach, expect, it, vi } from 'vitest';
import { captureVideoFrame, createVideoSceneReader } from '../src/media/capture';
afterEach(() => vi.restoreAllMocks());
it('takes scene checks and model pixels only from the bound visible playback canvas', () => {
  const video = document.createElement('video'),
    display = document.createElement('canvas');
  display.width = 320;
  display.height = 180;
  Object.defineProperties(video, {
    readyState: { value: 3 },
    videoWidth: { value: 320 },
    videoHeight: { value: 180 },
  });
  const drawImage = vi.fn(),
    getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(8 * 8 * 4) }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
    getImageData,
  } as unknown as CanvasRenderingContext2D);
  captureVideoFrame(video, 120, 384, display);
  createVideoSceneReader(video, display)();
  expect(drawImage.mock.calls.map((call) => call[0])).toEqual([display, display]);
  Object.defineProperty(video, 'mediaKeys', { value: {} });
  expect(() => captureVideoFrame(video, 200, 384, display)).toThrow();
  expect(() => createVideoSceneReader(video, display)()).toThrow();
});
