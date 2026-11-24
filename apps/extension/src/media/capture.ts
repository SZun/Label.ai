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
import { matchesDisplayedJpeg, readCachedOriginal } from '../cached-original';

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
    frame = pixels(element, element.naturalWidth, element.naturalHeight, MAX_SIDE, 0);
  } else {
    // Embedded CSS images are decoded locally. External background URLs are never refetched.
    if (!embeddedOriginal(source)) throw new Error('Background pixels are inaccessible');
    const image = new Image();
    image.src = source;
    await image.decode();
    frame = pixels(image, image.naturalWidth, image.naturalHeight, MAX_SIDE, 0);
  }
  let original = embeddedOriginal(source);
  const addressed = contentAddressedSource(source, location.href);
  if (!original && addressed?.mime === 'image/jpeg' && element instanceof HTMLImageElement) {
    const candidate = await fetchContentAddressed(addressed.url, location.href, signal);
    if (
      candidate &&
      (await matchesDisplayedJpeg(
        element,
        source,
        decodeBase64(candidate.base64, MAX_ORIGINAL_BYTES),
        signal,
      ))
    )
      original = candidate;
  }
  if (!original && !signal.aborted && element instanceof HTMLImageElement)
    original = await readCachedOriginal(element, source);
  return { frame, ...(original ? { original } : {}) };
}

export function captureVideoFrame(video: HTMLVideoElement, timestampMs: number): FramePayload {
  if (video.readyState < 2 || video.mediaKeys) throw new Error('Video pixels are unavailable');
  return pixels(video, video.videoWidth, video.videoHeight, VIDEO_MAX_SIDE, timestampMs);
}
