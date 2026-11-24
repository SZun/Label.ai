import { MODEL, WASM_RUNTIME } from './model.ts';
type PinnedAsset = { filename: string; bytes: number; sha256: string };

export async function loadPackagedWasm(assetBaseUrl: string): Promise<Uint8Array> {
  return loadPackagedAsset(assetBaseUrl, WASM_RUNTIME);
}

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
  return validatePinnedBytes(bytes, MODEL);
}

async function validatePinnedBytes(bytes: Uint8Array, asset: PinnedAsset): Promise<void> {
  if (bytes.byteLength !== asset.bytes) throw new Error('Packaged asset size mismatch');
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== asset.sha256) throw new Error('Packaged asset checksum mismatch');
}

export async function loadPackagedModel(assetBaseUrl: string): Promise<Uint8Array> {
  return loadPackagedAsset(assetBaseUrl, MODEL);
}

async function loadPackagedAsset(assetBaseUrl: string, asset: PinnedAsset): Promise<Uint8Array> {
  const url = packagedAssetUrl(assetBaseUrl, asset.filename);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    // Fetches only pinned packaged model/WASM resources. No media or analysis data is transmitted.
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('Packaged asset unavailable');
    const announced = response.headers.get('content-length');
    if (announced !== null && Number(announced) !== asset.bytes) throw new Error('Packaged asset size mismatch');
    const reader = response.body.getReader();
    const bytes = new Uint8Array(asset.bytes);
    let offset = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > bytes.byteLength) throw new Error('Packaged asset size limit exceeded');
        bytes.set(value, offset);
        offset += value.byteLength;
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (offset !== asset.bytes) throw new Error('Packaged asset truncated');
    await validatePinnedBytes(bytes, asset);
    return bytes;
  } finally { clearTimeout(timeout); }
}
