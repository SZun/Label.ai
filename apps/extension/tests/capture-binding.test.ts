import { beforeEach, expect, it, vi } from 'vitest';
import { captureImage } from '../src/media/capture';
import { fetchContentAddressed } from '../src/transport/acquire';
import { matchesDisplayedOriginal, readCachedOriginal } from '../src/cached-original';

vi.mock('../src/transport/acquire', () => ({ fetchContentAddressed: vi.fn() }));
vi.mock('../src/cached-original', () => ({
  matchesDisplayedOriginal: vi.fn(),
  readCachedOriginal: vi.fn(),
}));
const candidate = { base64: '/9j/2Q==', mime: 'image/jpeg' };
const source = `${location.origin}/assets/${'a'.repeat(64)}.jpg`;
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage() {},
    getImageData() {
      return { data: new Uint8ClampedArray(16) };
    },
  } as unknown as CanvasRenderingContext2D);
  vi.mocked(fetchContentAddressed).mockResolvedValue(candidate);
  vi.mocked(readCachedOriginal).mockResolvedValue(undefined);
});
function image() {
  const element = document.createElement('img');
  Object.defineProperties(element, {
    complete: { value: true },
    naturalWidth: { value: 2 },
    naturalHeight: { value: 2 },
    currentSrc: { value: source },
  });
  return element;
}
it('requires displayed pixels to match a hash-addressed signed candidate', async () => {
  vi.mocked(matchesDisplayedOriginal).mockResolvedValue(false);
  const result = await captureImage(image(), source, new AbortController().signal);
  expect(result.original).toBeUndefined();
  expect(result.frame).toBeDefined();
});
it('admits addressed JPEG originals only after full displayed source comparison', async () => {
  vi.mocked(matchesDisplayedOriginal).mockResolvedValue(true);
  const element = image();
  const controller = new AbortController();
  const result = await captureImage(element, source, controller.signal);
  expect(result.original).toEqual(candidate);
  expect(matchesDisplayedOriginal).toHaveBeenCalledWith(
    element,
    source,
    Uint8Array.from([255, 216, 255, 217]),
    'image/jpeg',
    controller.signal,
  );
});
