import { readBounded } from '../cached-original';
import { DEFAULT_SETTINGS, isEligiblePage } from '../core/policy';

export function eligiblePublicMediaUrl(source: string): boolean {
  try {
    const url = new URL(source);
    const host = url.hostname.replace(/\.$/, '');
    return (
      url.protocol === 'https:' &&
      !url.hash &&
      host.includes('.') &&
      !/^\d+(?:\.\d+){3}$/.test(host) &&
      !host.startsWith('[') &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local') &&
      !Array.from(url.searchParams.keys()).some((key) =>
        /token|^(?:x-amz-|x-goog-|signature$|sig$|auth(?:orization)?$|password$|api[_-]?key$|client[_-]?secret$|jwt$)/i.test(
          key,
        ),
      ) &&
      isEligiblePage(source, DEFAULT_SETTINGS)
    );
  } catch {
    return false;
  }
}

// This fetch is made by the content script, subject to the page origin's CORS policy.
export async function readPublicMedia(
  source: string,
  signal: AbortSignal,
  current: () => boolean,
  limits: { allowedTypes: readonly string[]; maxBytes: number; requireWholeFile?: boolean },
) {
  if (signal.aborted || !current() || !eligiblePublicMediaUrl(source)) return;
  const responseType = new URL(source).origin === location.origin ? 'basic' : 'cors';
  const response = await fetch(source, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    cache: 'force-cache',
    signal,
  });
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const length = response.headers.get('content-length');
  if (
    signal.aborted ||
    !current() ||
    !response.ok ||
    response.type !== responseType ||
    response.redirected ||
    response.url !== source ||
    !mime ||
    !limits.allowedTypes.includes(mime) ||
    /(?:^|,)\s*(?:private|no-store)\b/i.test(response.headers.get('cache-control') ?? '') ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > limits.maxBytes))
  )
    return;
  let expectedLength: number | undefined;
  if (limits.requireWholeFile) {
    const range = response.headers.get('content-range');
    if (response.status === 206) {
      // An ordinary single GET can yield a 206. Accept only an exposed range
      // that covers the entire bounded representation, never assemble ranges.
      const match = /^bytes 0-(\d+)\/(\d+)$/i.exec(range ?? '');
      if (!match) return;
      expectedLength = Number(match[2]);
      if (
        !expectedLength ||
        expectedLength > limits.maxBytes ||
        Number(match[1]) !== expectedLength - 1 ||
        (length !== null && Number(length) !== expectedLength)
      )
        return;
    } else {
      if (response.status !== 200 || range !== null) return;
      expectedLength = length === null ? undefined : Number(length);
    }
  }
  const bytes = await readBounded(response, signal, expectedLength ?? limits.maxBytes);
  if (
    !bytes ||
    signal.aborted ||
    !current() ||
    (expectedLength !== undefined && expectedLength !== bytes.byteLength)
  )
    return;
  return { bytes, mime };
}
