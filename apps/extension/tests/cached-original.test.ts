import { describe, expect, it, vi } from 'vitest';
import { cacheEligible, eligibleJpeg, readCachedOriginal } from '../src/cached-original';

const source = 'https://publisher.example/art/reference.jpg';
const frame = Uint8Array.of(255, 216, 255, 192, 0, 11, 8, 0, 20, 0, 30, 1, 1, 17, 0, 255, 217);
const header = (value: string) =>
  new Headers({ 'cache-control': value, 'content-type': 'image/jpeg' });

describe('public cache-only originals', () => {
  it('requires an explicit public cache response for a plain same-origin URL', () => {
    expect(cacheEligible(source, 'https://publisher.example')).toBe(true);
    for (const url of [
      source + '?token=abc',
      source + '#secret',
      'https://elsewhere.example/a',
      'data:image/jpeg,abc',
      'https://alice@publisher.example/image',
    ]) {
      expect(cacheEligible(url, 'https://publisher.example')).toBe(false);
    }
  });
  it('reads bounded JPEG dimensions before allocating decoded bitmaps', () => {
    expect(eligibleJpeg(frame, 30, 20)).toBe(true);
    expect(eligibleJpeg(frame, 29, 20)).toBe(false);
    expect(eligibleJpeg(frame.subarray(0, 10), 30, 20)).toBe(false);
    expect(eligibleJpeg(Uint8Array.of(255, 216, 255, 224, 0, 0), 30, 20)).toBe(false);
  });
  it.each(['private', 'no-store', 'public, private', 'max-age=3600'])(
    'rejects cache directive %s',
    async (directive) => {
      const response = new Response(frame, { headers: header(directive) });
      Object.defineProperty(response, 'url', { value: source });
      const fetch = vi.fn().mockResolvedValue(response);
      vi.stubGlobal('fetch', fetch);
      vi.stubGlobal('location', new URL(source));
      try {
        const image = {
          currentSrc: source,
          naturalWidth: 30,
          naturalHeight: 20,
          complete: true,
          isConnected: true,
        } as HTMLImageElement;
        expect(await readCachedOriginal(image, source)).toBeUndefined();
        expect(fetch).toHaveBeenCalledWith(
          source,
          expect.objectContaining({
            cache: 'only-if-cached',
            mode: 'same-origin',
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
          }),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

it('only binds cached originals with equal intrinsic pixels and the current source', async () => {
  const image = {
    currentSrc: source,
    naturalWidth: 30,
    naturalHeight: 20,
    complete: true,
    isConnected: true,
  } as HTMLImageElement;
  const texture = { width: 30, height: 20, close: vi.fn() };
  const bytes = new Uint8ClampedArray(30 * 20 * 4);
  const candidate = bytes.slice();
  const ctx = { drawImage: vi.fn(), clearRect: vi.fn(), getImageData: vi.fn() };
  const canvas = { getContext: () => ctx };
  const makeResponse = () => {
    const res = new Response(frame, { headers: header('public, max-age=120') });
    Object.defineProperty(res, 'url', { value: source });
    return res;
  };
  vi.stubGlobal('location', new URL(source));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => makeResponse()),
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => texture),
  );
  const create = vi
    .spyOn(document, 'createElement')
    .mockReturnValue(canvas as unknown as HTMLCanvasElement);
  try {
    ctx.getImageData.mockReturnValueOnce({ data: bytes }).mockReturnValueOnce({ data: candidate });
    expect((await readCachedOriginal(image, source))?.mime).toBe('image/jpeg');
    candidate[17] = 23;
    ctx.getImageData.mockReturnValueOnce({ data: bytes }).mockReturnValueOnce({ data: candidate });
    expect(await readCachedOriginal(image, source)).toBeUndefined();
    expect(texture.close).toHaveBeenCalledTimes(2);
    expect(await readCachedOriginal(image, source + '?changed')).toBeUndefined();
  } finally {
    create.mockRestore();
    vi.unstubAllGlobals();
  }
});
