import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { canReadCorsVideo, readCorsVideoFrames } from '../src/media/cors-video';

const source = 'https://clips.example/news/clip.webm';
const bytes = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 119, 101, 98, 109);
const samples = [125, 450, 875];
let player: HTMLVideoElement;
let decoder: HTMLVideoElement;
let fetchFile: ReturnType<typeof vi.fn>;
let release: Mock<(url: string) => void>;
let seek: Mock<(time: number) => void>;
let signal: AbortController;

function response(data = bytes, mime = 'video/webm', status = 200, type = 'cors') {
  const result = new Response(data, { status, headers: { 'content-type': mime } });
  Object.defineProperties(result, { url: { value: source }, type: { value: type } });
  return result;
}

beforeEach(() => {
  signal = new AbortController();
  player = document.body.appendChild(document.createElement('video'));
  player.src = source;
  Object.defineProperties(player, {
    currentSrc: { get: () => player.src },
    duration: { value: 4, configurable: true },
    readyState: { value: 4, configurable: true },
    videoWidth: { value: 160 },
    videoHeight: { value: 90 },
  });
  decoder = document.createElement('video');
  let time = 0;
  seek = vi.fn((value: number) => {
    time = value;
    queueMicrotask(() => decoder.dispatchEvent(new Event('seeked')));
  });
  Object.defineProperties(decoder, {
    duration: { value: 4, configurable: true },
    videoWidth: { value: 160 },
    videoHeight: { value: 90 },
    readyState: { value: 4 },
    currentTime: { get: () => time, set: seek },
    src: {
      set() {
        queueMicrotask(() => decoder.dispatchEvent(new Event('loadedmetadata')));
      },
    },
  });
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
    tag === 'video' ? decoder : create(tag),
  );
  vi.spyOn(decoder, 'load').mockImplementation(() => {});
  vi.spyOn(decoder, 'play').mockRejectedValue(new Error('should never play'));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: () => ({ data: new Uint8ClampedArray(160 * 90 * 4) }),
  } as unknown as CanvasRenderingContext2D);
  fetchFile = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetchFile);
  vi.stubGlobal('location', new URL('https://publisher.example/watch'));
  release = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = vi.fn(() => 'blob:https://publisher.example/local');
      static override revokeObjectURL = release;
    },
  );
});

afterEach(() => {
  player.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['video/webm', 'video/mp4'])(
  'decodes only observed times in an inert, muted local %s decoder',
  async (mime) => {
    if (mime === 'video/mp4')
      fetchFile.mockResolvedValue(
        response(
          Uint8Array.of(0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0),
          mime,
        ),
      );
    expect(canReadCorsVideo(player, source)).toBe(true);
    const result = await readCorsVideoFrames(player, source, samples, signal.signal);
    expect(result?.map((f) => f.timestampMs)).toEqual(samples);
    expect(fetchFile).toHaveBeenCalledWith(
      source,
      expect.objectContaining({
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(seek.mock.calls.map(([time]) => time)).toEqual(samples.map((t) => t / 1000));
    expect(decoder.play).not.toHaveBeenCalled();
    expect(decoder.muted).toBe(true);
    expect(decoder.isConnected).toBe(false);
    expect(player.currentTime).toBe(0);
    expect(player.src).toBe(source);
    expect(release).toHaveBeenCalledOnce();
  },
);

it.each(['opaque', 'partial', 'truncated', 'oversized', 'private', 'redirect', 'mime', 'data'])(
  'abstains before creating a decoder for %s responses',
  async (kind) => {
    const reply = response(
      kind === 'data' ? Uint8Array.of(1, 2, 3) : bytes,
      kind === 'mime' ? 'application/vnd.apple.mpegurl' : 'video/webm',
      kind === 'partial' ? 206 : 200,
      kind === 'opaque' ? 'opaque' : 'cors',
    );
    if (kind === 'truncated') reply.headers.set('content-length', String(bytes.length + 9));
    if (kind === 'oversized') reply.headers.set('content-length', String(17 * 1024 * 1024));
    if (kind === 'private') reply.headers.set('cache-control', 'private');
    if (kind === 'redirect') Object.defineProperty(reply, 'redirected', { value: true });
    fetchFile.mockResolvedValue(reply);
    expect(await readCorsVideoFrames(player, source, samples, signal.signal)).toBeUndefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  },
);

it('rechecks the page source after each seek and discards partial results', async () => {
  seek.mockImplementationOnce((time: number) => {
    player.src = 'https://clips.example/news/different.webm';
    queueMicrotask(() => decoder.dispatchEvent(new Event('seeked')));
  });
  expect(await readCorsVideoFrames(player, source, samples, signal.signal)).toBeUndefined();
  expect(seek).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledOnce();
});

it('aborts a pending seek promptly and releases the local file', async () => {
  seek.mockImplementation(() => signal.abort());
  expect(await readCorsVideoFrames(player, source, samples, signal.signal)).toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
});

it('rejects decoder metadata that differs from the presented clip', async () => {
  Object.defineProperty(decoder, 'duration', { value: 5 });
  expect(await readCorsVideoFrames(player, source, samples, signal.signal)).toBeUndefined();
  expect(seek).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it.each([
  'signed',
  'local',
  'same-origin',
  'credentials',
  'media-stream',
  'drm',
  'budget',
  'duration',
  'out-of-range',
])('avoids a network request for %s inputs', async (kind) => {
  if (kind === 'signed') player.src = source + '?token=secret';
  if (kind === 'local') player.src = 'https://127.0.0.1/v.mp4';
  if (kind === 'same-origin') player.src = 'https://publisher.example/v.mp4';
  if (kind === 'credentials') player.crossOrigin = 'use-credentials';
  if (kind === 'media-stream') Object.defineProperty(player, 'srcObject', { value: {} });
  if (kind === 'drm') Object.defineProperty(player, 'mediaKeys', { value: {} });
  if (kind === 'duration') Object.defineProperty(player, 'duration', { value: Infinity });
  const times =
    kind === 'budget'
      ? Array.from({ length: 100 }, (_, i) => i)
      : kind === 'out-of-range'
        ? [0, 100, 4500]
        : samples;
  expect(await readCorsVideoFrames(player, player.src, times, signal.signal)).toBeUndefined();
  expect(fetchFile).not.toHaveBeenCalled();
});

it('retains fully observed timestamps if the visible player buffers for its next loop', async () => {
  fetchFile.mockImplementationOnce(async () => {
    Object.defineProperty(player, 'readyState', { value: 1 });
    return response();
  });
  const frames = await readCorsVideoFrames(player, source, [0, 100, 200], signal.signal);
  expect(frames?.map((frame) => frame.timestampMs)).toEqual([0, 100, 200]);
});

it.each([false, true])(
  'reads one complete 206 with Content-Length present: %s',
  async (includeLength) => {
    const response206 = response(bytes, 'video/webm', 206);
    response206.headers.set('content-range', 'bytes 0-11/12');
    if (includeLength) response206.headers.set('content-length', '12');
    fetchFile.mockResolvedValue(response206);
    expect((await readCorsVideoFrames(player, source, samples, signal.signal))?.length).toBe(3);
    expect(fetchFile).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [206, 'bytes 1-11/12', '11'],
  [206, 'bytes 0-10/12', '11'],
  [206, 'bytes 0-11/*', '12'],
  [206, 'bytes 0-12/13', undefined],
  [206, 'bytes 0-10/11', undefined],
  [206, 'bytes 0-11/12', '11'],
  [206, 'bytes 0-11/12, 0-11/12', '12'],
  [206, 'bytes 0-16777216/16777217', undefined],
  [200, 'bytes 0-11/12', '12'],
] as const)(
  'declines inconsistent status %i range %s and length %s',
  async (status, range, length) => {
    const res = response(bytes, 'video/webm', status);
    res.headers.set('content-range', range);
    if (length) res.headers.set('content-length', length);
    fetchFile.mockResolvedValue(res);
    expect(await readCorsVideoFrames(player, source, samples, signal.signal)).toBeUndefined();
    expect(fetchFile).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  },
);

const mp4 = Uint8Array.of(
  0,
  0,
  0,
  20,
  102,
  116,
  121,
  112,
  105,
  115,
  111,
  109,
  0,
  0,
  0,
  0,
  109,
  112,
  52,
  49,
);
it.each([
  { data: bytes, expected: 'video/webm' },
  { data: mp4, expected: 'video/mp4' },
])('identifies a binary CDN object as $expected before decode', async ({ data, expected }) => {
  fetchFile.mockResolvedValue(response(data, 'application/octet-stream'));
  expect((await readCorsVideoFrames(player, source, samples, signal.signal))?.length).toBe(3);
  expect(URL.createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: expected }));
  expect(fetchFile).toHaveBeenCalledTimes(1);
});

it.each([
  Uint8Array.of(1, 2, 3),
  Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 110, 111, 112, 101),
  Uint8Array.of(0, 0, 0, 16, 102, 116, 121, 112, 97, 118, 105, 102, 0, 0, 0, 0),
])('declines a binary object without an MP4 or WebM container signature', async (data) => {
  fetchFile.mockResolvedValue(response(data, 'application/octet-stream'));
  expect(await readCorsVideoFrames(player, source, samples, signal.signal)).toBeUndefined();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(fetchFile).toHaveBeenCalledTimes(1);
});

it('stops reading the body as soon as it exceeds the declared whole range', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(bytes);
      },
      pull(controller) {
        controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const res = new Response(body, {
    status: 206,
    headers: {
      'content-type': 'video/webm',
      'content-range': 'bytes 0-10/11',
    },
  });
  Object.defineProperties(res, { url: { value: source }, type: { value: 'cors' } });
  fetchFile.mockResolvedValue(res);
  expect(await readCorsVideoFrames(player, source, samples, signal.signal)).toBeUndefined();
  expect(cancel).toHaveBeenCalledOnce();
  expect(fetchFile).toHaveBeenCalledOnce();
});
