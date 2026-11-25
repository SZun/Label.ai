import { eligiblePng, jpegDimensions, MAX_COMPARE_PIXELS, readBounded } from '../cached-original';
import { staticWebpDimensions } from './webp';
import { DEFAULT_SETTINGS, isEligiblePage } from '../core/policy';
import { MAX_ORIGINAL_BYTES } from '../core/protocol';

function eligibleCdnUrl(source: string): boolean {
  try {
    const url = new URL(source);
    const host = url.hostname.replace(/\.$/, '');
    return (
      url.protocol === 'https:' &&
      url.origin !== location.origin &&
      !url.hash &&
      host !== 'localhost' &&
      !/^\d+(?:\.\d+){3}$/.test(host) &&
      !host.startsWith('[') &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local') &&
      !Array.from(url.searchParams.keys()).some((key) =>
        /^(?:x-amz-|x-goog-|token$|access_token$|signature$|sig$|auth$|password$|api[_-]?key$)/i.test(
          key,
        ),
      ) &&
      isEligiblePage(source, DEFAULT_SETTINGS)
    );
  } catch {
    return false;
  }
}

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
  if (width < 1 || height < 1 || width * height > MAX_COMPARE_PIXELS) return false;
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
    !eligibleCdnUrl(source)
  )
    return;

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 5000);
  try {
    const response = await fetch(source, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'force-cache',
      signal: controller.signal,
    });
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const length = response.headers.get('content-length');
    if (
      controller.signal.aborted ||
      !current() ||
      !response.ok ||
      response.type !== 'cors' ||
      response.redirected ||
      response.url !== source ||
      (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') ||
      /(?:^|,)\s*(?:private|no-store)\b/i.test(response.headers.get('cache-control') ?? '') ||
      (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_ORIGINAL_BYTES))
    )
      return;
    const bytes = await readBounded(response, controller.signal);
    if (!bytes || !current()) return;
    const size = encodedDimensions(bytes, mime);
    if (!size || !matchesImageDimensions(image, source, size.width, size.height)) return;
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
