import { encodeBase64, MAX_ORIGINAL_BYTES } from './core/protocol';

const MAX_COMPARE_PIXELS = 2_000_000;
type Original = { base64: string; mime: string };

export function cacheEligible(source: string, origin: string): boolean {
  try {
    const url = new URL(source);
    return url.origin === origin && /^https?:$/.test(url.protocol) &&
      !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
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
      return length >= 8 && bytes[index + 2] === 8 &&
        ((bytes[index + 3] << 8) | bytes[index + 4]) === height &&
        ((bytes[index + 5] << 8) | bytes[index + 6]) === width;
    }
    index += length;
  }
  return false;
}

async function readBounded(response: Response): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ORIGINAL_BYTES) { await reader.cancel(); return; }
      parts.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  } finally { reader.releaseLock(); }
}

export async function readCachedOriginal(image: HTMLImageElement, source: string): Promise<Original | undefined> {
  const { naturalWidth: width, naturalHeight: height } = image;
  const current = () => image.isConnected && image.complete && image.currentSrc === source &&
    image.naturalWidth === width && image.naturalHeight === height;
  if (!current() || width < 1 || height < 1 || width * height > MAX_COMPARE_PIXELS ||
      !cacheEligible(source, location.origin)) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  let bitmap: ImageBitmap | undefined;
  try {
    const response = await fetch(source, {
      cache: 'only-if-cached', mode: 'same-origin', credentials: 'omit',
      referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
    });
    const directives = (response.headers.get('cache-control') ?? '').toLowerCase().split(',').map(v => v.trim().split('=')[0]);
    if (!response.ok || response.redirected || response.url !== source ||
        !directives.includes('public') || directives.includes('private') || directives.includes('no-store') ||
        response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg' ||
        Number(response.headers.get('content-length')) > MAX_ORIGINAL_BYTES) return;
    const bytes = await readBounded(response);
    if (!bytes || !current() || !eligibleJpeg(bytes, width, height)) return;
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    if (!current() || controller.signal.aborted || bitmap.width !== width || bitmap.height !== height) return;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(image, 0, 0, width, height);
    const displayed = ctx.getImageData(0, 0, width, height).data;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    const cached = ctx.getImageData(0, 0, width, height).data;
    if (!displayed.every((v, i) => v === cached[i]) || !current()) return;
    return { base64: encodeBase64(bytes), mime: 'image/jpeg' };
  } catch { return; } finally {
    clearTimeout(timeout);
    controller.abort();
    bitmap?.close();
  }
}
