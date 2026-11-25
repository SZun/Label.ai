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
  allowedTypes: readonly string[],
  maxBytes: number,
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
    response.status !== 200 ||
    response.headers.has('content-range') ||
    response.type !== responseType ||
    response.redirected ||
    response.url !== source ||
    !mime ||
    !allowedTypes.includes(mime) ||
    /(?:^|,)\s*(?:private|no-store)\b/i.test(response.headers.get('cache-control') ?? '') ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes))
  )
    return;
  const bytes = await readBounded(response, signal, maxBytes);
  if (!bytes || !current()) return;
  return { bytes, mime, contentLength: length === null ? undefined : Number(length) };
}
