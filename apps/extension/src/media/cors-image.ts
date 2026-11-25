import { eligiblePng, jpegDimensions, MAX_COMPARE_PIXELS } from '../cached-original';
import { staticWebpDimensions } from './webp';
import { eligiblePublicMediaUrl, readPublicMedia } from './public-media';
import { MAX_ORIGINAL_BYTES } from '../core/protocol';

function encodedDimensions(bytes: Uint8Array, mime: string) {
  if (mime === 'image/jpeg') return jpegDimensions(bytes);
  if (mime === 'image/webp') return staticWebpDimensions(bytes);
  if (mime !== 'image/png' || bytes.length < 24) return;
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(16),
    height = header.getUint32(20);
  return eligiblePng(bytes, width, height) ? { width, height } : undefined;
}

// naturalWidth/Height are density-corrected CSS pixels for srcset. Only admit
// a different intrinsic size when this exact selected candidate declares it.
function matchesImageDimensions(
  image: HTMLImageElement,
  source: string,
  width: number,
  height: number,
) {
  if (width === image.naturalWidth && height === image.naturalHeight) return true;
  const sets = [image.srcset];
  if (image.parentElement instanceof HTMLPictureElement)
    for (const child of image.parentElement.querySelectorAll('source[srcset]'))
      sets.push(child.getAttribute('srcset')!);
  for (const set of sets) {
    for (const candidate of set.split(',')) {
      const match = /^(\S+)\s+([\d.]+)([xw])$/.exec(candidate.trim());
      if (!match || new URL(match[1], image.baseURI).href !== source) continue;
      const declared = Number(match[2]);
      if (match[3] === 'w' && width !== declared) continue;
      const scale = match[3] === 'w' ? width / image.naturalWidth : declared;
      if (
        scale > 0 &&
        Math.abs(width / scale - image.naturalWidth) < 1 &&
        Math.abs(height / scale - image.naturalHeight) < 1
      )
        return true;
    }
  }
  return false;
}

/** Read the exact current image URL with ordinary page-origin CORS. Its bytes are
 * usable for a visual estimate only: a mutable publisher URL can serve a new image. */
export async function readCorsBitmap(
  image: HTMLImageElement,
  source: string,
  signal: AbortSignal,
): Promise<ImageBitmap | undefined> {
  const { naturalWidth: width, naturalHeight: height } = image;
  const current = () =>
    !signal.aborted &&
    image.complete &&
    image.isConnected &&
    image.currentSrc === source &&
    image.naturalWidth === width &&
    image.naturalHeight === height;
  if (
    !current() ||
    width < 1 ||
    height < 1 ||
    width * height > MAX_COMPARE_PIXELS ||
    image.crossOrigin === 'use-credentials' ||
    !eligiblePublicMediaUrl(source) ||
    new URL(source).origin === location.origin
  )
    return;

  return readPublicBitmap(source, signal, current, (w, h) =>
    matchesImageDimensions(image, source, w, h),
  );
}

/** Public static raster bytes support local inference. Never use a second network
 * response as provenance for a displayed image. */
export async function readPublicBitmap(
  source: string,
  signal: AbortSignal,
  current: () => boolean,
  matchesSize?: (width: number, height: number) => boolean,
): Promise<ImageBitmap | undefined> {
  if (signal.aborted || !current() || !eligiblePublicMediaUrl(source)) return;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 5000);
  try {
    const file = await readPublicMedia(
      source,
      controller.signal,
      current,
      ['image/jpeg', 'image/png', 'image/webp'],
      MAX_ORIGINAL_BYTES,
    );
    if (!file) return;
    const { bytes, mime } = file;
    const size = encodedDimensions(bytes, mime);
    if (
      !size ||
      size.width < 1 ||
      size.height < 1 ||
      size.width * size.height > MAX_COMPARE_PIXELS ||
      (matchesSize && !matchesSize(size.width, size.height))
    )
      return;
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    if (
      !current() ||
      controller.signal.aborted ||
      bitmap.width !== size.width ||
      bitmap.height !== size.height
    ) {
      bitmap.close();
      return;
    }
    return bitmap;
  } catch {
    return;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
