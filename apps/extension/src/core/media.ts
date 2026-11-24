import { decodeBase64, MAX_ORIGINAL_BYTES, MAX_SIDE } from './protocol';

export function boundedDimensions(width: number, height: number, maxSide = MAX_SIDE): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width * height > 40_000_000) return null;
  const ratio = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

export function embeddedOriginal(source: string): { base64: string; mime: string } | undefined {
  const separator = source.indexOf(',');
  if (separator < 0 || separator > 40) return undefined;
  const header = /^data:(image\/(?:jpeg|png|webp|avif));base64$/i.exec(source.slice(0, separator));
  if (!header?.[1]) return undefined;
  const base64 = source.slice(separator + 1);
  try { decodeBase64(base64, MAX_ORIGINAL_BYTES); } catch { return undefined; }
  return { mime: header[1].toLowerCase(), base64 };
}

export function contentAddressedSource(source: string, pageUrl: string): { url: string; sha256: string; mime: string } | null {
  try {
    const url = new URL(source);
    if (url.origin !== new URL(pageUrl).origin || url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:')) return null;
    const match = /^\/assets\/([a-f0-9]{64})\.(jpg|jpeg|png|webp|avif)$/.exec(url.pathname);
    if (!match?.[1] || !match[2]) return null;
    const extension = match[2] === 'jpg' ? 'jpeg' : match[2];
    return { url: url.href, sha256: match[1], mime: `image/${extension}` };
  } catch { return null; }
}
