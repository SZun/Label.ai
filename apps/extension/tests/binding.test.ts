import { describe, expect, it } from 'vitest';
import { acceptsDecision, decodeBase64 } from '../src/core/protocol';

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
});
