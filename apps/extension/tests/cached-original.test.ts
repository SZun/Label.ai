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

it('binds static PNG originals but rejects animation, oversized dimensions, and malformed chunks', async () => {
  const { eligiblePng } = await import('../src/cached-original');
  const png = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 30, 0, 0, 0, 20, 8, 2, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 73, 68, 65, 84, 0, 0, 0, 0, 0, 0, 0, 0, 0, 73, 69, 78, 68, 0, 0,
    0, 0,
  ]);
  expect(eligiblePng(png, 30, 20)).toBe(true);
  expect(eligiblePng(png, 29, 20)).toBe(false);
  expect(eligiblePng(png.subarray(0, 40), 30, 20)).toBe(false);
  const animated = new Uint8Array([
    ...png.subarray(0, 33),
    0,
    0,
    0,
    8,
    97,
    99,
    84,
    76,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...png.subarray(33),
  ]);
  expect(eligiblePng(animated, 30, 20)).toBe(false);
});

it('does not read a canceled cached image or continue scanning after parent capture aborts', async () => {
  vi.stubGlobal('location', new URL(source));
  const controller = new AbortController();
  const fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
    const res = new Response(frame, { headers: header('public') });
    Object.defineProperty(res, 'url', { value: source });
    return res;
  });
  vi.stubGlobal('fetch', fetch);
  const image = {
    currentSrc: source,
    naturalWidth: 30,
    naturalHeight: 20,
    complete: true,
    isConnected: true,
  } as HTMLImageElement;
  try {
    expect(await readCachedOriginal(image, source, controller.signal)).toBeUndefined();
    expect(await readCachedOriginal(image, source, controller.signal)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
