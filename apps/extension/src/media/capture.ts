import { boundedDimensions, embeddedOriginal, contentAddressedSource } from '../core/media';
import {
  decodeBase64,
  encodeBase64,
  MAX_ORIGINAL_BYTES,
  MAX_SIDE,
  VIDEO_MAX_SIDE,
  type FramePayload,
  type AnalyzeRequest,
} from '../core/protocol';
import { fetchContentAddressed } from '../transport/acquire';
import { matchesDisplayedOriginal, readCachedOriginal } from '../cached-original';
import { readBlobOriginal } from './blob-original';
import { backgroundCrop, backgroundImageSource } from './background-image';
import { readCorsBitmap, readPublicBitmap } from './cors-image';

export function sourceFor(element: Element): string {
  if (element instanceof HTMLImageElement) return element.currentSrc || element.src;
  if (element instanceof HTMLVideoElement) return element.currentSrc || element.src;
  return backgroundImageSource(element);
}

function pixels(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSide: number,
  timestampMs: number,
  crop?: { x: number; y: number; width: number; height: number },
): FramePayload {
  const dimensions = boundedDimensions(width, height, maxSide);
  if (!dimensions) throw new Error('Unsupported media dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas is unavailable');
  try {
    if (crop)
      context.drawImage(
        source,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        dimensions.width,
        dimensions.height,
      );
    else context.drawImage(source, 0, 0, dimensions.width, dimensions.height);
    const rgba = context.getImageData(0, 0, dimensions.width, dimensions.height).data;
    return { ...dimensions, rgba: encodeBase64(rgba), timestampMs };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function bitmapFrame(bitmap: ImageBitmap, current: () => boolean, background?: Element) {
  try {
    if (!current()) throw new Error('Obsolete image capture');
    const crop = background && backgroundCrop(background, bitmap);
    if (background && !crop)
      throw new DOMException('Unsupported background layout', 'SecurityError');
    return {
      frame: pixels(
        bitmap,
        crop?.width ?? bitmap.width,
        crop?.height ?? bitmap.height,
        MAX_SIDE,
        0,
        crop,
      ),
    };
  } finally {
    bitmap.close();
  }
}

export async function captureImage(
  element: Element,
  source: string,
  signal: AbortSignal,
): Promise<{ frame: FramePayload; original?: AnalyzeRequest['original'] }> {
  let frame: FramePayload;
  if (element instanceof HTMLImageElement) {
    if (!element.complete || !element.naturalWidth) throw new Error('Image is not ready');
    try {
      frame = pixels(element, element.naturalWidth, element.naturalHeight, MAX_SIDE, 0);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'SecurityError') throw error;
      const bitmap = await readCorsBitmap(element, source, signal);
      if (!bitmap) throw error;
      return bitmapFrame(
        bitmap,
        () => !signal.aborted && element.isConnected && element.currentSrc === source,
      );
    }
  } else {
    if (!source.startsWith('data:image/')) {
      const current = () => !signal.aborted && element.isConnected && sourceFor(element) === source;
      const bitmap = await readPublicBitmap(source, signal, current);
      if (!bitmap) throw new DOMException('Background pixels are inaccessible', 'SecurityError');
      return bitmapFrame(bitmap, current, element);
    }
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
