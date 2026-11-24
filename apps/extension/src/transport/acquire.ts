import { contentAddressedSource } from '../core/media';
import { MAX_ORIGINAL_BYTES, encodeBase64 } from '../core/protocol';

/** The only external acquisition path. No arbitrary URL, credentials or redirects. */
export async function fetchContentAddressed(source: string, pageUrl: string, signal: AbortSignal): Promise<{ base64: string; mime: string } | undefined> {
  const admitted = contentAddressedSource(source, pageUrl);
  if (!admitted) return undefined;
  const response = await fetch(admitted.url, { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'force-cache', signal });
  if (!response.ok || !response.body || response.url !== admitted.url) return undefined;
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_ORIGINAL_BYTES)) { await response.body.cancel(); return undefined; }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_ORIGINAL_BYTES || signal.aborted) { await reader.cancel(); return undefined; }
      parts.push(result.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const part of parts) { bytes.set(part, position); position += part.length; }
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hash !== admitted.sha256) return undefined;
  return { base64: encodeBase64(bytes), mime: admitted.mime };
}
