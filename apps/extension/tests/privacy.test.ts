import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, isEligiblePage, normalizeOrigin } from '../src/core/policy';

const approved = { enabled: true, consentVersion: 1, approvedOrigins: ['https://news.example'] };
describe('ACQ-01 local access and privacy admission', () => {
  it('enables only explicitly approved HTTPS origins after consent', () => {
    expect(isEligiblePage('https://news.example/article', approved)).toBe(true);
    expect(isEligiblePage('https://news.example/article', DEFAULT_SETTINGS)).toBe(false);
    expect(isEligiblePage('https://elsewhere.example/article', approved)).toBe(false);
  });
  it.each(['https://news.example/login', 'https://news.example/messages/123', 'https://news.example/checkout', 'file:///private.jpg', 'chrome://settings', 'https://user:secret@news.example/article'])('rejects sensitive or restricted context %s', (url) => {
    expect(isEligiblePage(url, approved)).toBe(false);
  });
  it('revocation, old consent and password-bearing pages are ineligible', () => {
    expect(isEligiblePage('https://news.example/article', { ...approved, enabled: false })).toBe(false);
    expect(isEligiblePage('https://news.example/article', { ...approved, consentVersion: 0 })).toBe(false);
    expect(isEligiblePage('https://news.example/article', approved, true)).toBe(false);
  });
  it('normalizes origins without granting broader domains or credentials', () => {
    expect(normalizeOrigin('https://news.example/article')).toBe('https://news.example');
    expect(normalizeOrigin('https://user:secret@news.example')).toBeNull();
    expect(normalizeOrigin('http://example.com')).toBeNull();
    expect(normalizeOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
  });
});
