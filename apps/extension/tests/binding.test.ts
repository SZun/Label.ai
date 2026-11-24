import { describe, expect, it } from 'vitest';
import { acceptsDecision, decodeBase64, encodeBase64, isAnalyzeRequest, MAX_ORIGINAL_BYTES } from '../src/core/protocol';

const binding = { instanceId: 'image-1', generation: 2, requestId: 'job-2' };
const positive = { ...binding, status: 'COMPLETED', shouldLabel: true, policyVersion: 'v1', expiresAt: 200 };
describe('DISC-04 and UX-06 positive source binding', () => {
  it('accepts only a completed current positive', () => { expect(acceptsDecision(binding, positive, 100)).toBe(true); });
  it.each([
    { ...positive, generation: 1 }, { ...positive, requestId: 'job-1' },
    { ...positive, instanceId: 'image-2' }, { ...positive, status: 'PROCESSING' },
    { ...positive, shouldLabel: false }, { ...positive, shouldLabel: 'true' },
    { ...positive, expiresAt: 99 }, { ...positive, policyVersion: '' }, null,
  ])('rejects a stale, malformed or nonpositive response', (value) => {
    expect(acceptsDecision(binding, value, 100)).toBe(false);
  });
  it('bounds decoded local payloads and rejects malformed base64', () => {
    expect(Array.from(decodeBase64('AQID', 3))).toEqual([1, 2, 3]);
    expect(() => decodeBase64('AQID', 2)).toThrow();
    expect(() => decodeBase64('not%%base64', 100)).toThrow();
  });
  it('decodes a bounded multi-megabyte original without a recursive regex', () => {
    const bytes = new Uint8Array(2_500_000);
    bytes[0] = 0xff; bytes[bytes.length - 1] = 0xd9;
    const decoded = decodeBase64(encodeBase64(bytes), MAX_ORIGINAL_BYTES);
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe(0xff);
    expect(decoded.at(-1)).toBe(0xd9);
  });
  it('admits a bounded whole original video without inventing sampled frames', () => {
    const request = { ...binding, type: 'label-ai:analyze', kind: 'video', original: { mime: 'video/mp4', base64: 'AQID' } };
    expect(isAnalyzeRequest(request)).toBe(true);
    expect(isAnalyzeRequest({ ...request, original: { mime: 'text/html', base64: 'AQID' } })).toBe(false);
    expect(isAnalyzeRequest({ ...request, original: { mime: 'video/mp4', base64: 'A'.repeat(Math.ceil(MAX_ORIGINAL_BYTES / 3) * 4 + 4) } })).toBe(false);
  });
  it('caps video message bytes, even when each frame dimensions are valid', () => {
    const request = { ...binding, type: 'label-ai:analyze', kind: 'video', durationMs: 1000, coverage: 1, frames: Array.from({ length: 12 }, (_, index) => ({ width: 480, height: 480, timestampMs: index * 100, rgba: 'A'.repeat(480 * 480 * 4 * 4 / 3) })) };
    expect(isAnalyzeRequest(request)).toBe(true);
    expect(isAnalyzeRequest({ ...request, original: { mime: 'video/mp4', base64: 'A'.repeat(Math.ceil(MAX_ORIGINAL_BYTES / 3) * 4) } })).toBe(false);
    expect(isAnalyzeRequest({ ...request, frames: [{ width: 1, height: 1, timestampMs: 0, rgba: 'A'.repeat(4_000_000) }, ...request.frames.slice(1)] })).toBe(false);
  });
});
