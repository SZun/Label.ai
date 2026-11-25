import { afterEach, expect, it, vi } from 'vitest';
import { readBlobOriginal } from '../src/media/blob-original';
import { acquireVideoOriginal } from '../src/media/video-original';
import { MAX_ORIGINAL_BYTES } from '../src/core/protocol';

const origin = 'https://publisher.example';
const source = 'blob:' + origin + '/36c51fc3-2a38-4c16-9fc0-6f2216f8f561';
const bytes = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
function response(payload = bytes, mime = 'video/mp4', url = source, length = payload.byteLength) {
  const reply = new Response(payload, {
    headers: { 'content-type': mime, 'content-length': String(length) },
  });
  Object.defineProperty(reply, 'url', { value: url });
  return reply;
}
function video() {
  return {
    currentSrc: source,
    srcObject: null,
    mediaKeys: null,
    isConnected: true,
    readyState: 2,
  } as HTMLVideoElement;
}
afterEach(() => vi.unstubAllGlobals());

it('reads only an immutable same-origin Blob URL without network credentials or a request body', async () => {
  const fetch = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetch);
  expect(
    await readBlobOriginal(source, origin, ['video/mp4'], new AbortController().signal),
  ).toEqual({ mime: 'video/mp4', base64: btoa(String.fromCharCode(...bytes)) });
  expect(fetch.mock.calls[0][0]).toEqual(source);
  expect(fetch.mock.calls[0][1]).toMatchObject({
    mode: 'same-origin',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
  });
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('body');
  fetch.mockClear();
  for (const candidate of [
    'https://publisher.example/clip.mp4',
    'blob:https://elsewhere.example/id',
    source + '#t=5',
    source + '?query=1',
    'blob:null/id',
  ])
    expect(
      await readBlobOriginal(candidate, origin, ['video/mp4'], new AbortController().signal),
    ).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects revoked, redirected, mislabeled, oversized or aborted Blob reads', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  fetch.mockRejectedValueOnce(new TypeError('Revoked Blob'));
  fetch.mockResolvedValueOnce(response(bytes, 'video/mp4', source + 'changed'));
  fetch.mockResolvedValueOnce(response(bytes, 'application/octet-stream'));
  fetch.mockResolvedValueOnce(response(bytes, 'video/mp4', source, MAX_ORIGINAL_BYTES + 1));
  for (let i = 0; i < 4; i++)
    expect(
      await readBlobOriginal(source, origin, ['video/mp4'], new AbortController().signal),
    ).toBeUndefined();
  const controller = new AbortController();
  controller.abort();
  expect(await readBlobOriginal(source, origin, ['video/mp4'], controller.signal)).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('accepts only a loaded full MP4 Blob and rejects source replacement during asynchronous acquisition', async () => {
  vi.stubGlobal('location', new URL(origin));
  const fetch = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  expect(await acquireVideoOriginal(video(), source, controller.signal)).toEqual({
    mime: 'video/mp4',
    base64: btoa(String.fromCharCode(...bytes)),
  });
  const replaced = video();
  fetch.mockImplementationOnce(async () => {
    Object.defineProperty(replaced, 'currentSrc', { value: source + 'new' });
    return response();
  });
  expect(await acquireVideoOriginal(replaced, source, controller.signal)).toBeUndefined();
  fetch.mockResolvedValueOnce(response(Uint8Array.from([1, 2, 3])));
  expect(await acquireVideoOriginal(video(), source, controller.signal)).toBeUndefined();
  expect(
    await acquireVideoOriginal(
      { ...video(), mediaKeys: {} } as HTMLVideoElement,
      source,
      controller.signal,
    ),
  ).toBeUndefined();
  expect(
    await acquireVideoOriginal(
      { ...video(), srcObject: {} } as HTMLVideoElement,
      source,
      controller.signal,
    ),
  ).toBeUndefined();
});
