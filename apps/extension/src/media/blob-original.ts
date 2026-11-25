import { encodeBase64, MAX_ORIGINAL_BYTES } from '../core/protocol';

/** Read an immutable object URL from this origin, never an HTTP(s) URL or a MediaSource. */
export async function readBlobOriginal(
  source: string,
  origin: string,
  mimeTypes: readonly string[],
  signal: AbortSignal,
): Promise<{ base64: string; mime: string } | undefined> {
  try {
    const url = new URL(source);
    if (
      url.protocol !== 'blob:' ||
      url.origin === 'null' ||
      url.origin !== origin ||
      url.search ||
      url.hash ||
      signal.aborted
    )
      return;
  } catch {
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 1500);
  try {
    const response = await fetch(source, {
      mode: 'same-origin',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const length = response.headers.get('content-length');
    if (
      !response.ok ||
      response.url !== source ||
      response.redirected ||
      !response.body ||
      !mime ||
      !mimeTypes.includes(mime) ||
      (length && (!/^\d+$/.test(length) || Number(length) > MAX_ORIGINAL_BYTES))
    )
      return;
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ORIGINAL_BYTES || controller.signal.aborted) {
          await reader.cancel();
          return;
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (controller.signal.aborted || !size || (length && size !== Number(length))) return;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return { base64: encodeBase64(bytes), mime };
  } catch {
    // Revoked URLs, MediaSource objects and inaccessible blobs cannot prove original bytes.
    return;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    controller.abort();
  }
}
