import { encodeBase64, MAX_ORIGINAL_BYTES } from './core/protocol';

const MAX_COMPARE_PIXELS = 5_000_000;
type Original = { base64: string; mime: string };

export function cacheEligible(source: string, origin: string): boolean {
  try {
    const url = new URL(source);
    return (
      url.origin === origin &&
      /^https?:$/.test(url.protocol) &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// Check encoded dimensions before invoking a native decoder on arbitrary cached bytes.
export function eligibleJpeg(bytes: Uint8Array, width: number, height: number): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || width * height > MAX_COMPARE_PIXELS) return false;
  let index = 2;
  while (index + 4 < bytes.length && bytes[index] === 0xff) {
    while (bytes[index] === 0xff) index++;
    const marker = bytes[index++];
    const length = (bytes[index] << 8) | bytes[index + 1];
    if (length < 2 || index + length > bytes.length || marker === 0xda) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      return (
        length >= 8 &&
        bytes[index + 2] === 8 &&
        ((bytes[index + 3] << 8) | bytes[index + 4]) === height &&
        ((bytes[index + 5] << 8) | bytes[index + 6]) === width
      );
    }
    index += length;
  }
  return false;
}

export function eligiblePng(bytes: Uint8Array, width: number, height: number): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.length < 45 ||
    !signature.every((value, index) => bytes[index] === value) ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_COMPARE_PIXELS
  )
    return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452 || // IHDR
    view.getUint32(16) !== width ||
    view.getUint32(20) !== height
  )
    return false;
  let hasImageData = false;
  for (let offset = 33; offset + 12 <= bytes.length; ) {
    const length = view.getUint32(offset);
    const tag = view.getUint32(offset + 4);
    const next = offset + length + 12;
    if (next > bytes.length) return false;
    if ([0x6163544c, 0x6663544c, 0x66644154, 0x49484452].includes(tag)) return false; // APNG or repeated IHDR
    if (tag === 0x49444154) hasImageData = true; // IDAT
    if (tag === 0x49454e44) return hasImageData && length === 0 && next === bytes.length; // IEND
    offset = next;
  }
  return false;
}

function eligibleOriginal(bytes: Uint8Array, mime: string, width: number, height: number): boolean {
  return mime === 'image/jpeg'
    ? eligibleJpeg(bytes, width, height)
    : mime === 'image/png' && eligiblePng(bytes, width, height);
}

async function readBounded(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ORIGINAL_BYTES || signal.aborted) {
        await reader.cancel();
        return;
      }
      parts.push(value);
    }
    if (signal.aborted) return;
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  } finally {
    reader.releaseLock();
  }
}

export async function readCachedOriginal(
  image: HTMLImageElement,
  source: string,
  signal?: AbortSignal,
): Promise<Original | undefined> {
  const { naturalWidth: width, naturalHeight: height } = image;
  const current = () =>
    !signal?.aborted &&
    image.isConnected &&
    image.complete &&
    image.currentSrc === source &&
    image.naturalWidth === width &&
    image.naturalHeight === height;
  if (
    !current() ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_COMPARE_PIXELS ||
    !cacheEligible(source, location.origin)
  )
    return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 1500);
  try {
    const response = await fetch(source, {
      cache: 'only-if-cached',
      mode: 'same-origin',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: controller.signal,
    });
    const directives = (response.headers.get('cache-control') ?? '')
      .toLowerCase()
      .split(',')
      .map((v) => v.trim().split('=')[0]);
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (
      controller.signal.aborted ||
      !response.ok ||
      response.redirected ||
      response.url !== source ||
      !directives.includes('public') ||
      directives.includes('private') ||
      directives.includes('no-store') ||
      (mime !== 'image/jpeg' && mime !== 'image/png') ||
      Number(response.headers.get('content-length')) > MAX_ORIGINAL_BYTES
    )
      return;
    const bytes = await readBounded(response, controller.signal);
    if (!bytes || !current() || !eligibleOriginal(bytes, mime, width, height)) return;
    if (!(await matchesDisplayedOriginal(image, source, bytes, mime, controller.signal))) return;
    return { base64: encodeBase64(bytes), mime };
  } catch {
    return;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

export async function matchesDisplayedOriginal(
  image: HTMLImageElement,
  source: string,
  bytes: Uint8Array,
  mime: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const { naturalWidth: width, naturalHeight: height } = image;
  const current = () =>
    image.isConnected &&
    image.complete &&
    image.currentSrc === source &&
    image.naturalWidth === width &&
    image.naturalHeight === height &&
    !signal?.aborted;
  if (
    !current() ||
    width < 1 ||
    height < 1 ||
    bytes.length > MAX_ORIGINAL_BYTES ||
    !eligibleOriginal(bytes, mime, width, height)
  )
    return false;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime }));
    if (!current() || signal?.aborted || bitmap.width !== width || bitmap.height !== height)
      return false;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = Math.min(height, 64);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    for (let row = 0; row < height; row += canvas.height) {
      const rows = Math.min(canvas.height, height - row);
      if (signal?.aborted) return false;
      ctx.clearRect(0, 0, width, rows);
      ctx.drawImage(image, 0, row, width, rows, 0, 0, width, rows);
      const displayed = ctx.getImageData(0, 0, width, rows).data;
      ctx.clearRect(0, 0, width, rows);
      ctx.drawImage(bitmap, 0, row, width, rows, 0, 0, width, rows);
      const cached = ctx.getImageData(0, 0, width, rows).data;
      if (!displayed.every((v, i) => v === cached[i])) return false;
    }
    return current();
  } catch {
    return false;
  } finally {
    bitmap?.close();
  }
}
