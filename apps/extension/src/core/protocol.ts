export interface Binding {
  instanceId: string;
  generation: number;
  requestId: string;
}

export interface LocalDecision extends Binding {
  status: 'COMPLETED' | 'UNSUPPORTED' | 'FAILED' | 'CANCELED';
  shouldLabel: boolean;
  policyVersion: string;
  expiresAt: number;
}

export function acceptsDecision(binding: Binding, value: unknown, now = Date.now()): value is LocalDecision {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<LocalDecision>;
  return response.instanceId === binding.instanceId && response.generation === binding.generation
    && response.requestId === binding.requestId && response.status === 'COMPLETED'
    && response.shouldLabel === true && typeof response.policyVersion === 'string' && response.policyVersion.length > 0
    && typeof response.expiresAt === 'number' && Number.isFinite(response.expiresAt) && response.expiresAt > now;
}

export function decodeBase64(input: string, maxBytes: number): Uint8Array<ArrayBuffer> {
  if (input.length > Math.ceil(maxBytes / 3) * 4 || input.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input)
    || (input.indexOf('=') !== -1 && input.indexOf('=') < input.length - 2)) throw new Error('Invalid local payload');
  const decoded = atob(input);
  if (decoded.length > maxBytes) throw new Error('Local payload exceeds limit');
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

export function encodeBase64(bytes: Uint8Array | Uint8ClampedArray): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}

export interface FramePayload {
  rgba: string;
  width: number;
  height: number;
  timestampMs: number;
}

export interface AnalyzeRequest extends Binding {
  type: 'label-ai:analyze';
  kind: 'image' | 'video';
  frame?: FramePayload;
  frames?: FramePayload[];
  durationMs?: number;
  coverage?: number;
  original?: { base64: string; mime: string };
}

export const MAX_SIDE = 1024;
export const VIDEO_MAX_SIDE = 480;
export const MAX_ORIGINAL_BYTES = 4 * 1024 * 1024;
export const MAX_MESSAGE_CHARACTERS = 15 * 1024 * 1024;

export function isAnalyzeRequest(value: unknown): value is AnalyzeRequest {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AnalyzeRequest>;
  if (item.type !== 'label-ai:analyze' || !['image', 'video'].includes(item.kind ?? '')
    || typeof item.instanceId !== 'string' || item.instanceId.length > 100
    || typeof item.requestId !== 'string' || item.requestId.length > 100
    || !Number.isSafeInteger(item.generation) || (item.generation ?? -1) < 0) return false;
  const validFrame = (frame: unknown): frame is FramePayload => {
    if (!frame || typeof frame !== 'object') return false;
    const f = frame as Partial<FramePayload>;
    return Number.isInteger(f.width) && (f.width ?? 0) > 0 && (f.width ?? 0) <= MAX_SIDE
      && Number.isInteger(f.height) && (f.height ?? 0) > 0 && (f.height ?? 0) <= MAX_SIDE
      && typeof f.timestampMs === 'number' && Number.isFinite(f.timestampMs) && f.timestampMs >= 0
      && typeof f.rgba === 'string' && f.rgba.length <= Math.ceil((f.width! * f.height! * 4) / 3) * 4;
  };
  if (item.original && (typeof item.original.base64 !== 'string'
    || item.original.base64.length > Math.ceil(MAX_ORIGINAL_BYTES / 3) * 4
    || typeof item.original.mime !== 'string'
    || !(item.kind === 'video' ? /^video\/mp4$/ : /^image\/(jpeg|png|webp|avif)$/).test(item.original.mime))) return false;
  if (item.kind === 'video') {
    if (!item.frames) return Boolean(item.original);
    if (!Array.isArray(item.frames) || item.frames.length < 3 || item.frames.length > 12
      || !item.frames.every((frame) => validFrame(frame) && frame.width <= VIDEO_MAX_SIDE && frame.height <= VIDEO_MAX_SIDE)
      || !Number.isFinite(item.durationMs) || (item.durationMs ?? 0) <= 0
      || typeof item.coverage !== 'number' || item.coverage < 0 || item.coverage > 1) return false;
    return item.frames.reduce((bytes, frame) => bytes + frame.rgba.length, item.original?.base64.length ?? 0) < MAX_MESSAGE_CHARACTERS;
  }
  if (!validFrame(item.frame)) return false;
  return item.frame.rgba.length + (item.original?.base64.length ?? 0) < MAX_MESSAGE_CHARACTERS;
}
