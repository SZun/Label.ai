import { isLocalTestUrl } from './local-test';
import { acceptsDecision, type Binding, type LocalDecision } from './protocol';

export type GalleryState =
  | 'pending'
  | 'labeled'
  | 'completed-no-label'
  | 'unsupported'
  | 'failed'
  | 'canceled';

/** Only the explicitly marked, top-level loopback test gallery receives diagnostics. */
export function galleryDiagnosticPage(url: string, document: Document, topFrame: boolean): boolean {
  return (
    topFrame &&
    isLocalTestUrl(url) &&
    ['/', '/columns'].includes(new URL(url).pathname) &&
    document.querySelector('meta[name="label-ai-test-gallery"][content="1"]') !== null
  );
}

/** Report a coarse outcome only. No scores, asset bytes, URLs or other evidence are exposed. */
export function galleryReplyState(
  binding: Binding,
  value: unknown,
  now = Date.now(),
): GalleryState {
  if (acceptsDecision(binding, value, now))
    return value.shouldLabel ? 'labeled' : 'completed-no-label';
  if (!value || typeof value !== 'object') return 'failed';
  const response = value as Partial<LocalDecision>;
  if (
    response.instanceId !== binding.instanceId ||
    response.requestId !== binding.requestId ||
    response.generation !== binding.generation ||
    response.shouldLabel !== false
  )
    return 'failed';

  switch (response.status) {
    case 'COMPLETED':
      return 'completed-no-label';
    case 'UNSUPPORTED':
      return 'unsupported';
    case 'CANCELED':
    case 'BUSY':
      return 'canceled';
    default:
      return 'failed';
  }
}
