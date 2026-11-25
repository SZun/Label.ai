import { supportsDimensions } from './preprocess.ts';

/** A strict envelope check before native decoding; the browser still verifies
 * CRCs and compressed pixel data. Only extension-captured, bounded still PNG is
 * accepted here. Browser-decoded JPEG/WebP/etc use analyzeRgba instead.
 */
export function inspectBoundedPng(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || bytes.length > 8 * 1024 * 1024 || signature.some((value, index) => bytes[index] !== value)) {
    throw new RangeError('Invalid or unsupported PNG envelope');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, chunks = 0, width = 0, height = 0, hasPixels = false;
  while (offset + 12 <= bytes.length && chunks++ < 256) {
    const length = view.getUint32(offset);
    const name = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (length > bytes.length - offset - 12) throw new RangeError('Truncated PNG chunk');
    if (chunks === 1 && (name !== 'IHDR' || length !== 13)) throw new RangeError('Missing PNG header');
    if (name === 'IHDR') {
      if (chunks !== 1) throw new RangeError('Repeated PNG header');
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      if (!supportsDimensions(width, height, 'image')) throw new RangeError('Unsupported PNG dimensions');
    }
    if (['acTL', 'fcTL', 'fdAT'].includes(name)) throw new RangeError('Animated PNG needs temporal analysis');
    if (name === 'IDAT') hasPixels = true;
    offset += length + 12;
    if (name === 'IEND') {
      if (!hasPixels || length !== 0 || offset !== bytes.length) throw new RangeError('Invalid PNG termination');
      return { width, height };
    }
  }
  throw new RangeError('Truncated or excessive PNG chunks');
}
