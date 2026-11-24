import { describe, expect, it } from 'vitest';
import {
  CONSENT_VERSION,
  DEFAULT_SETTINGS,
  hostPermissionPattern,
  isEligiblePage,
  normalizeOrigin,
  normalizeSettings,
} from '../src/core/policy';

const enabled = { enabled: true, consentVersion: CONSENT_VERSION };
describe('ACQ-01 automatic site access and privacy admission', () => {
  it('automatically admits eligible HTTP and HTTPS pages without a site list', () => {
    expect(isEligiblePage('https://news.example/article', DEFAULT_SETTINGS)).toBe(true);
    expect(isEligiblePage('https://elsewhere.example/article', enabled)).toBe(true);
    expect(isEligiblePage('http://example.com/article', enabled)).toBe(true);
    expect(isEligiblePage('http://127.0.0.1:8765/', enabled)).toBe(true);
  });
  it.each([
    'https://news.example/login',
    'https://news.example/messages/123',
    'https://news.example/checkout',
    'file:///private.jpg',
    'chrome://settings',
    'https://user:secret@news.example/article',
    'https://private.local/dashboard',
    'http://192.168.1.1/dashboard',
    'http://intranet/dashboard',
  ])('rejects sensitive or restricted context %s', (url) => {
    expect(isEligiblePage(url, enabled)).toBe(false);
  });
  it('pause, old consent and password-bearing pages are ineligible', () => {
    expect(isEligiblePage('https://news.example/article', { ...enabled, enabled: false })).toBe(
      false,
    );
    expect(isEligiblePage('https://news.example/article', { ...enabled, consentVersion: 0 })).toBe(
      false,
    );
    expect(isEligiblePage('https://news.example/article', enabled, true)).toBe(false);
  });
  it('normalizes public web origins, without credentials', () => {
    expect(normalizeOrigin('https://news.example/article')).toBe('https://news.example');
    expect(normalizeOrigin('https://user:secret@news.example')).toBeNull();
    expect(normalizeOrigin('http://example.com')).toBe('http://example.com');
    expect(normalizeOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
  });
  it('uses browser-valid port-free host patterns for the native host-access check', () => {
    expect(hostPermissionPattern('http://localhost:4173')).toBe('http://localhost/*');
    expect(hostPermissionPattern('https://news.example:8443')).toBe('https://news.example/*');
    expect(hostPermissionPattern('file:///private')).toBeNull();
    expect(isEligiblePage('https://news.example:8443/story', enabled)).toBe(true);
    expect(isEligiblePage('https://news.example/story', enabled)).toBe(true);
  });
  it('migrates previous settings, dropping the site list and preserving an explicit pause', () => {
    expect(normalizeSettings(undefined)).toEqual(enabled);
    expect(
      normalizeSettings({
        enabled: true,
        consentVersion: 1,
        approvedOrigins: ['https://news.example'],
      }),
    ).toEqual(enabled);
    expect(
      normalizeSettings({
        enabled: false,
        consentVersion: 1,
        approvedOrigins: ['https://news.example'],
      }),
    ).toEqual({ ...enabled, enabled: false });
    expect(normalizeSettings({ enabled: false, consentVersion: 0, approvedOrigins: [] })).toEqual({
      ...enabled,
      enabled: false,
    });
    expect(normalizeSettings({ enabled: 'yes' })).toEqual({ ...enabled, enabled: false });
  });
  it('fails closed for malformed percent-encoded page paths', () => {
    expect(isEligiblePage('https://news.example/%E0%A4%A', enabled)).toBe(false);
  });
  it.each([
    'https://news.example/#/messages/secret',
    'https://news.example/#!/checkout',
    'https://news.example/?route=/account/billing',
    'https://news.example/?path=%2Finbox%2Fsecret',
  ])('excludes private SPA routes expressed in fragments or route parameters: %s', (url) => {
    expect(isEligiblePage(url, enabled)).toBe(false);
  });
});
