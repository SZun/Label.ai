import { boundedDimensions, embeddedOriginal, contentAddressedSource } from '../core/media';
import {
  decodeBase64,
  encodeBase64,
  MAX_ORIGINAL_BYTES,
  MAX_SIDE,
  VIDEO_MAX_SIDE,
  type FramePayload,
} from '../core/protocol';
import { fetchContentAddressed } from '../transport/acquire';
import { matchesDisplayedOriginal, readCachedOriginal } from '../cached-original';
import { readBlobOriginal } from './blob-original';
import { readCorsBitmap } from './cors-image';

export function sourceFor(element: Element): string {
  if (element instanceof HTMLImageElement) return element.currentSrc || element.src;
  if (element instanceof HTMLVideoElement) return element.currentSrc || element.src;
  const background = getComputedStyle(element).backgroundImage;
  const match = /^url\(["']?(data:image\/[^"')]+)["']?\)$/.exec(background);
  return match?.[1] ?? '';
}

function pixels(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSide: number,
  timestampMs: number,
): FramePayload {
  const dimensions = boundedDimensions(width, height, maxSide);
  if (!dimensions) throw new Error('Unsupported media dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable');
  try {
    context.drawImage(source, 0, 0, dimensions.width, dimensions.height);
    const rgba = context.getImageData(0, 0, dimensions.width, dimensions.height).data;
    return { ...dimensions, rgba: encodeBase64(rgba), timestampMs };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function captureImage(element: Element, source: string, signal: AbortSignal) {
  let frame: FramePayload;
  if (element instanceof HTMLImageElement) {
    if (!element.complete || !element.naturalWidth) throw new Error('Image is not ready');
    try {
      frame = pixels(element, element.naturalWidth, element.naturalHeight, MAX_SIDE, 0);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error;
      const bitmap = await readCorsBitmap(element, source, signal);
      if (!bitmap) throw error;
      try {
        if (signal.aborted || !element.isConnected || element.currentSrc !== source) throw error;
        return { frame: pixels(bitmap, bitmap.width, bitmap.height, MAX_SIDE, 0) };
      } finally {
        bitmap.close();
      }
    }
  } else {
    // Embedded CSS images are decoded locally. External background URLs are never refetched.
    if (!embeddedOriginal(source)) throw new Error('Background pixels are inaccessible');
    const image = new Image();
    image.src = source;
    await image.decode();
    frame = pixels(image, image.naturalWidth, image.naturalHeight, MAX_SIDE, 0);
  }
  if (signal.aborted || sourceFor(element) !== source) throw new Error('Obsolete image capture');
  let original = embeddedOriginal(source);
  if (!original && element instanceof HTMLImageElement && source.startsWith('blob:')) {
    const candidate = await readBlobOriginal(
      source,
      location.origin,
      ['image/jpeg', 'image/png'],
      signal,
    );
    if (
      candidate &&
      (await matchesDisplayedOriginal(
        element,
        source,
        decodeBase64(candidate.base64, MAX_ORIGINAL_BYTES),
        candidate.mime,
        signal,
      ))
    )
      original = candidate;
  }
  const addressed = contentAddressedSource(source, location.href);
  if (
    !original &&
    (addressed?.mime === 'image/jpeg' || addressed?.mime === 'image/png') &&
    element instanceof HTMLImageElement
  ) {
    const candidate = await fetchContentAddressed(addressed.url, location.href, signal);
    if (
      candidate &&
      (await matchesDisplayedOriginal(
        element,
        source,
        decodeBase64(candidate.base64, MAX_ORIGINAL_BYTES),
        candidate.mime,
        signal,
      ))
    )
      original = candidate;
  }
  if (!original && !signal.aborted && element instanceof HTMLImageElement)
    original = await readCachedOriginal(element, source, signal);
  if (signal.aborted || sourceFor(element) !== source) throw new Error('Obsolete image capture');
  return { frame, ...(original ? { original } : {}) };
}

export function captureVideoFrame(video: HTMLVideoElement, timestampMs: number): FramePayload {
  if (video.readyState < 2 || video.mediaKeys) throw new Error('Video pixels are unavailable');
  return pixels(video, video.videoWidth, video.videoHeight, VIDEO_MAX_SIDE, timestampMs);
}
