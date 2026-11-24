import { afterEach, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { fetchContentAddressed } from '../src/transport/acquire';
import { MAX_ORIGINAL_BYTES } from '../src/core/protocol';

const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const digest = createHash('sha256').update(bytes).digest('hex');
const source = `https://news.example/assets/${digest}.jpg`;
const page = 'https://news.example/story';
function response(payload = bytes, url = source, headers: HeadersInit = {}) {
  const result = new Response(payload, { headers });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
afterEach(() => vi.unstubAllGlobals());

it('retrieves only the authorized publisher resource without credentials, referrer, redirects or request body', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const fetcher = vi.fn().mockResolvedValue(response());
  vi.stubGlobal('fetch', fetcher);
  expect(await fetchContentAddressed(source, page, new AbortController().signal)).toEqual({ mime: 'image/jpeg', base64: '/9j/2Q==' });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0]).toBe(source);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'force-cache' });
  expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty('body');
});

it('does not fetch unbound URLs or stale canceled work', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  for (const candidate of ['https://elsewhere.example/assets/' + digest + '.jpg', 'https://news.example/photo.jpg', source + '?token=private']) {
    expect(await fetchContentAddressed(candidate, page, new AbortController().signal)).toBeUndefined();
  }
  const controller = new AbortController(); controller.abort();
  expect(await fetchContentAddressed(source, page, controller.signal)).toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects altered bytes, redirects and oversized original responses', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  fetcher.mockResolvedValueOnce(response(Uint8Array.from([1, 2, 3])));
  expect(await fetchContentAddressed(source, page, new AbortController().signal)).toBeUndefined();
  fetcher.mockResolvedValueOnce(response(bytes, source + '/redirect'));
  expect(await fetchContentAddressed(source, page, new AbortController().signal)).toBeUndefined();
  fetcher.mockResolvedValueOnce(response(bytes, source, { 'content-length': String(MAX_ORIGINAL_BYTES + 1) }));
  expect(await fetchContentAddressed(source, page, new AbortController().signal)).toBeUndefined();
  fetcher.mockResolvedValueOnce(response(new Uint8Array(MAX_ORIGINAL_BYTES + 1)));
  expect(await fetchContentAddressed(source, page, new AbortController().signal)).toBeUndefined();
});
