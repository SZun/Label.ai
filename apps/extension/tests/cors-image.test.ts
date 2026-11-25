import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureImage, sourceFor } from '../src/media/capture';

const source = 'https://media.publisher.example/art/cover.jpg';
const bytes = Uint8Array.of(255, 216, 255, 192, 0, 11, 8, 0, 20, 0, 30, 1, 1, 17, 0, 255, 217);
const taint = new DOMException('Canvas is tainted', 'SecurityError');
const bitmap = { width: 30, height: 20, close: vi.fn() };
const read = vi.fn();
const fetchImage = vi.fn();
let image: HTMLImageElement;
let cancel: AbortController;

function reply(mime = 'image/jpeg', data = bytes, url = source, type = 'cors') {
  const response = new Response(data, { headers: { 'content-type': mime } });
  Object.defineProperties(response, { url: { value: url }, type: { value: type } });
  return response;
}

beforeEach(() => {
  cancel = new AbortController();
  image = document.body.appendChild(document.createElement('img'));
  image.src = source;
  Object.defineProperties(image, {
    currentSrc: { get: () => image.src },
    complete: { value: true },
    naturalWidth: { value: 30 },
    naturalHeight: { value: 20 },
  });
  read
    .mockReset()
    .mockImplementationOnce(() => {
      throw taint;
    })
    .mockReturnValue({ data: new Uint8ClampedArray(30 * 20 * 4) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
    getImageData: read,
  } as unknown as CanvasRenderingContext2D);
  fetchImage.mockReset().mockResolvedValue(reply());
  vi.stubGlobal('fetch', fetchImage);
  vi.stubGlobal('location', new URL('https://publisher.example/article'));
  bitmap.close.mockClear();
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
});

afterEach(() => {
  image.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('gets model pixels through anonymous CORS for a displayed CDN image with a tainted canvas', async () => {
  const result = await captureImage(image, source, cancel.signal);
  expect(fetchImage).toHaveBeenCalledWith(
    source,
    expect.objectContaining({
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'force-cache',
    }),
  );
  expect(result.frame).toMatchObject({ width: 30, height: 20 });
  expect(result.original).toBeUndefined();
  expect(bitmap.close).toHaveBeenCalledOnce();
});

it('only attempts a second read after a browser canvas security error', async () => {
  read.mockReset().mockImplementation(() => {
    throw Error('canvas unavailable');
  });
  await expect(captureImage(image, source, cancel.signal)).rejects.toThrow('canvas unavailable');
  expect(fetchImage).not.toHaveBeenCalled();
});

it.each([
  'http://cdn.example/photo.jpg',
  'https://127.0.0.1/photo.jpg',
  'https://localhost/photo.jpg',
  'https://user:pass@cdn.example/photo.jpg',
  'https://cdn.example/private/photo.jpg',
])('declines a private or non-HTTPS source %s', async (url) => {
  image.src = url;
  await expect(captureImage(image, url, cancel.signal)).rejects.toThrow();
  expect(fetchImage).not.toHaveBeenCalled();
});

it.each([
  () => reply('image/svg+xml'),
  () => reply('image/jpeg', bytes, 'https://other.example/photo.jpg'),
  () => reply('image/jpeg', bytes, source, 'opaque'),
  () => reply('image/jpeg', bytes, source, 'basic'),
  () => reply('image/jpeg', Uint8Array.of(0, 1, 2)),
  () => {
    const response = reply();
    response.headers.set('content-length', '5500000');
    return response;
  },
])('rejects an unexpected or unbound response before decoding', async (make) => {
  fetchImage.mockResolvedValue(make());
  await expect(captureImage(image, source, cancel.signal)).rejects.toThrow();
  expect(createImageBitmap).not.toHaveBeenCalled();
});

it('drops and closes a decoded source if the publisher replaces it during acquisition', async () => {
  vi.mocked(createImageBitmap).mockImplementationOnce(async () => {
    image.src = 'https://media.publisher.example/next.jpg';
    return bitmap as unknown as ImageBitmap;
  });
  await expect(captureImage(image, source, cancel.signal)).rejects.toThrow();
  expect(bitmap.close).toHaveBeenCalledOnce();
});

it('discards a CORS read denied by the browser or canceled by the scanner', async () => {
  fetchImage.mockImplementation(async (_url, options) => {
    cancel.abort();
    expect(options.signal.aborted).toBe(true);
    throw new TypeError('Failed to fetch');
  });
  await expect(captureImage(image, source, cancel.signal)).rejects.toThrow();
  expect(fetchImage).toHaveBeenCalledOnce();
  expect(createImageBitmap).not.toHaveBeenCalled();
});

it('uses the dimensions of the selected public 2x thumbnail on Retina displays', async () => {
  const uri = source + '?utm_source=publisher';
  image.src = uri;
  image.srcset = source + ' 1x, ' + uri + ' 2x';
  const larger = bytes.slice();
  larger[8] = 40;
  larger[10] = 60;
  fetchImage.mockResolvedValue(reply('image/jpeg', larger, uri));
  vi.mocked(createImageBitmap).mockResolvedValue({
    ...bitmap,
    width: 60,
    height: 40,
  } as unknown as ImageBitmap);
  const result = await captureImage(image, uri, cancel.signal);
  expect(result.frame).toMatchObject({ width: 60, height: 40 });
  expect(result.original).toBeUndefined();
});

// Generated from a 30 x 20 red tile with Pillow/libwebp.
const losslessWebp = 'UklGRhwAAABXRUJQVlA4TA8AAAAvHcAEAAcQ/Y/+ByKi/wEA';
const lossyWebp =
  'UklGRkwAAABXRUJQVlA4IEAAAABwAwCdASoeABQAPm00lkekIyIhKAgAgA2JZQDKLoB+AABBlBAA/vCbQ//ILlhdcjX/8gP+QH/ID/+PfYwoMAAA';
const webpFixture = (base64 = lossyWebp) =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

it.each([losslessWebp, lossyWebp])('uses an ordinary static WebP thumbnail', async (encoded) => {
  fetchImage.mockResolvedValue(reply('image/webp', webpFixture(encoded)));
  expect((await captureImage(image, source, cancel.signal)).frame).toMatchObject({
    width: 30,
    height: 20,
  });
});
it.each(['animation', 'size', 'keyframe'])(
  'declines malformed or animated WebP: %s',
  async (issue) => {
    const data = webpFixture();
    if (issue === 'animation') data.set([65, 78, 73, 77], 12);
    if (issue === 'size') data[4] = 100;
    if (issue === 'keyframe') data[20] = 1;
    fetchImage.mockResolvedValue(reply('image/webp', data));
    await expect(captureImage(image, source, cancel.signal)).rejects.toThrow();
    expect(createImageBitmap).not.toHaveBeenCalled();
  },
);

function background(value: string) {
  const card = document.createElement('article');
  card.style.backgroundImage = value;
  card.style.backgroundSize = 'cover';
  card.style.backgroundPosition = '50% 50%';
  Object.defineProperties(card, {
    clientWidth: { value: 300, configurable: true },
    clientHeight: { value: 200 },
  });
  return document.body.appendChild(card);
}

it.each([
  ['https://publisher.example/images/story(1).jpg', 'basic'],
  [source, 'cors'],
])('reads the selected public CSS card image %s for local inference', async (url, type) => {
  const card = background(`url("${url}")`);
  try {
    expect(sourceFor(card)).toBe(url);
    expect(fetchImage).not.toHaveBeenCalled();
    fetchImage.mockResolvedValue(reply('image/jpeg', bytes, url, type));
    read.mockReset().mockReturnValue({ data: new Uint8ClampedArray(30 * 20 * 4) });
    const result = await captureImage(card, url, cancel.signal);
    expect(result.frame).toMatchObject({ width: 30, height: 20 });
    expect(result.original).toBeUndefined();
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(fetchImage).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        mode: 'cors',
      }),
    );
    expect(bitmap.close).toHaveBeenCalledOnce();
  } finally {
    card.remove();
  }
});

it.each([
  'linear-gradient(red, blue)',
  `url("${source}"), url("https://cdn.example/next.png")`,
  `linear-gradient(red, blue), url("${source}")`,
  `image-set(url("${source}") 1x)`,
  'url("https://cdn.example/card.jpg?token=secret")',
  'url("https://cdn.example/card.jpg?auth_token=secret")',
  'url("https://intranet./card.jpg")',
  'url("https://cdn.example/private/card.jpg")',
  'url("https://localhost/card.jpg")',
  'url("blob:https://publisher.example/a")',
])('skips unsupported or private CSS sources: %s', (value) => {
  const card = background(value);
  try {
    expect(sourceFor(card)).toBe('');
    expect(fetchImage).not.toHaveBeenCalled();
  } finally {
    card.remove();
  }
});

it('drops a decoded CSS card if the publisher replaces its image during the read', async () => {
  const card = background(`url("${source}")`);
  try {
    vi.mocked(createImageBitmap).mockImplementationOnce(async () => {
      card.style.backgroundImage = 'none';
      return bitmap as unknown as ImageBitmap;
    });
    await expect(captureImage(card, source, cancel.signal)).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalledOnce();
  } finally {
    card.remove();
  }
});

it('declines an oversized CSS card before decoding its bitmap', async () => {
  const card = background(`url("${source}")`);
  const large = bytes.slice();
  large.set([0x20, 0, 0x20, 0], 7);
  try {
    fetchImage.mockResolvedValue(reply('image/jpeg', large));
    await expect(captureImage(card, source, cancel.signal)).rejects.toThrow();
    expect(fetchImage).toHaveBeenCalledOnce();
    expect(createImageBitmap).not.toHaveBeenCalled();
  } finally {
    card.remove();
  }
});

it('classifies only the painted portion of a centered cover photo', async () => {
  const card = background(`url("${source}")`);
  Object.defineProperty(card, 'clientWidth', { value: 200 });
  try {
    read.mockReset().mockReturnValue({ data: new Uint8ClampedArray(20 * 20 * 4) });
    const { frame } = await captureImage(card, source, cancel.signal);
    const canvas = document.createElement('canvas').getContext('2d')!;
    expect(canvas.drawImage).toHaveBeenCalledWith(bitmap, 5, 0, 20, 20, 0, 0, 20, 20);
    expect(frame).toMatchObject({ width: 20, height: 20 });
  } finally {
    card.remove();
  }
});

it('does not treat sprite sheets or a parent with separate media as a card photo', () => {
  const card = background(`url("${source}")`);
  try {
    card.style.backgroundPosition = '-160px 0px';
    expect(sourceFor(card)).toBe('');
    card.style.backgroundPosition = 'center';
    card.style.backgroundSize = '640px 320px';
    expect(sourceFor(card)).toBe('');
    card.style.backgroundSize = 'cover';
    card.style.backgroundClip = 'text';
    expect(sourceFor(card)).toBe('');
    card.style.backgroundClip = 'border-box';
    card.style.backgroundRepeat = 'round';
    expect(sourceFor(card)).toBe('');
    card.style.backgroundRepeat = 'no-repeat';
    card.append(document.createElement('img'));
    expect(sourceFor(card)).toBe('');
  } finally {
    card.remove();
  }
});

it('does not classify a small auto-sized CSS texture repeated across a card', async () => {
  const card = background(`url("${source}")`);
  try {
    card.style.backgroundSize = 'auto';
    await expect(captureImage(card, source, cancel.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  } finally {
    card.remove();
  }
});

it('still accepts a decodable displayed CDN image returned from the publisher range cache', async () => {
  const ranged = new Response(bytes, {
    status: 206,
    headers: {
      'content-type': 'image/jpeg',
      'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
    },
  });
  Object.defineProperties(ranged, { url: { value: source }, type: { value: 'cors' } });
  fetchImage.mockResolvedValue(ranged);
  const { frame } = await captureImage(image, source, cancel.signal);
  expect(frame).toMatchObject({ width: 30, height: 20 });
});
