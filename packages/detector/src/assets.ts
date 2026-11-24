import { MODEL } from './model.ts';

export function packagedAssetUrl(baseUrl: string, name: string): string {
  const base = new URL(baseUrl);
  if (!['chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(base.protocol) ||
      !base.hostname || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) {
    throw new TypeError('Model assets must be packaged extension resources');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..')) throw new TypeError('Invalid packaged asset name');
  if (typeof location !== 'undefined' && ['chrome-extension:', 'moz-extension:', 'safari-web-extension:'].includes(location.protocol) &&
      (location.protocol !== base.protocol || location.hostname !== base.hostname)) {
    throw new TypeError('Packaged assets must belong to the current extension');
  }
  return new URL(name, base).href;
}

export async function validateModelBytes(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength !== MODEL.bytes) throw new Error('Packaged model size mismatch');
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== MODEL.sha256) throw new Error('Packaged model checksum mismatch');
}

export async function loadPackagedModel(assetBaseUrl: string): Promise<Uint8Array> {
  const url = packagedAssetUrl(assetBaseUrl, MODEL.filename);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    // The only fetch in the detector is to its pinned packaged model. No media or analysis data is transmitted.
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Packaged model unavailable');
    const announced = response.headers.get('content-length');
    if (announced !== null && Number(announced) !== MODEL.bytes) throw new Error('Packaged model size mismatch');
    const reader = response.body.getReader();
    const bytes = new Uint8Array(MODEL.bytes);
    let offset = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > bytes.byteLength) throw new Error('Packaged model size limit exceeded');
        bytes.set(value, offset);
        offset += value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (offset !== MODEL.bytes) throw new Error('Packaged model truncated');
    await validateModelBytes(bytes);
    return bytes;
  } finally { clearTimeout(timeout); }
}
