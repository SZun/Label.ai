/** WASM must come from the current application package, never a CDN or media URL. */
export function validatePackagedAssetUrl(candidate: string, documentUrl: string): string {
  const base = new URL(documentUrl);
  const url = new URL(candidate, base);
  const schemes = new Set(['chrome-extension:', 'safari-web-extension:', 'moz-extension:', 'https:', 'http:']);
  if (!schemes.has(base.protocol) || url.protocol !== base.protocol ||
      url.hostname !== base.hostname || url.port !== base.port ||
      url.username || url.password || url.search || url.hash ||
      (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('C2PA resources must be packaged at the current application origin');
  }
  return url.href;
}
