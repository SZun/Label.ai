import { describe, expect, it } from 'vitest';
import { galleryDiagnosticPage, galleryReplyState } from '../src/core/gallery-diagnostics';

const marker = '<meta name="label-ai-test-gallery" content="1">';
function page(html: string) {
  return new DOMParser().parseFromString(html, 'text/html');
}
const binding = { instanceId: 'asset', generation: 1, requestId: 'request' };
const positive = {
  ...binding,
  status: 'COMPLETED',
  shouldLabel: true,
  policyVersion: 'sample-v1',
  expiresAt: 200,
};

describe('Gallery-only diagnostics', () => {
  it('requires the explicit top-level HTTP loopback gallery marker', () => {
    expect(galleryDiagnosticPage('http://127.0.0.1:8765/', page(marker), true)).toBe(true);
    expect(galleryDiagnosticPage('http://localhost:4321/', page(marker), true)).toBe(true);
    expect(galleryDiagnosticPage('http://localhost:4321/columns', page(marker), true)).toBe(true);
    expect(galleryDiagnosticPage('http://localhost:4321/columns', page(''), true)).toBe(false);
    expect(galleryDiagnosticPage('http://localhost:4321/', page(''), true)).toBe(false);
    expect(galleryDiagnosticPage('https://example.com/', page(marker), true)).toBe(false);
    expect(galleryDiagnosticPage('http://localhost:4321/account', page(marker), true)).toBe(false);
    expect(galleryDiagnosticPage('http://localhost:4321/', page(marker), false)).toBe(false);
    expect(
      galleryDiagnosticPage(
        'http://localhost:4321/',
        page('<meta name="label-ai-test-gallery" content="0">'),
        true,
      ),
    ).toBe(false);
  });

  it('reports the outcome of the actual bound response without leaking evidence', () => {
    expect(galleryReplyState(binding, positive, 100)).toBe('labeled');
    expect(galleryReplyState(binding, { ...positive, shouldLabel: false }, 100)).toBe(
      'completed-no-label',
    );
    expect(
      galleryReplyState(binding, { ...positive, status: 'UNSUPPORTED', shouldLabel: false }, 100),
    ).toBe('unsupported');
    expect(
      galleryReplyState(binding, { ...positive, status: 'CANCELED', shouldLabel: false }, 100),
    ).toBe('canceled');
    expect(
      galleryReplyState(binding, { ...positive, status: 'BUSY', shouldLabel: false }, 100),
    ).toBe('canceled');
    expect(
      galleryReplyState(binding, { ...positive, status: 'FAILED', shouldLabel: false }, 100),
    ).toBe('failed');
    expect(galleryReplyState(binding, { ...positive, generation: 0 }, 100)).toBe('failed');
    expect(galleryReplyState(binding, positive, 201)).toBe('failed');
    expect(galleryReplyState(binding, undefined, 100)).toBe('failed');
  });
});
