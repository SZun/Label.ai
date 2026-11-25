import { afterEach, expect, it, vi } from 'vitest';
import {
  localTestDecision,
  LOCAL_TEST_IMAGE_THRESHOLD,
  LOCAL_TEST_VIDEO_THRESHOLD,
} from '../src/core/local-test';

const loopback = 'http://127.0.0.1:8765/';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('uses the actual completed raw image score, including its boundary', () => {
  expect(LOCAL_TEST_IMAGE_THRESHOLD).toBe(0.1);
  expect(localTestDecision(true, loopback, 'image', { status: 'COMPLETED', rawScore: 0.1 })).toBe(
    true,
  );
  expect(
    localTestDecision(true, loopback, 'image', { status: 'COMPLETED', rawScore: 0.0999 }),
  ).toBe(false);
  expect(localTestDecision(true, loopback, 'image', { status: 'COMPLETED', rawScore: 0.95 })).toBe(
    true,
  );
});

it('requires actual eligible video temporal evidence in addition to the score', () => {
  expect(LOCAL_TEST_VIDEO_THRESHOLD).toBe(0.2);
  const decision = (rawScore: number, eligible: boolean) =>
    localTestDecision(true, loopback, 'video', {
      status: 'COMPLETED',
      rawScore,
      temporal: { eligible },
    });
  expect(decision(0.2, true)).toBe(true);
  expect(decision(0.9, false)).toBe(false);
  expect(decision(0.1999, true)).toBe(false);
  expect(localTestDecision(true, loopback, 'video', { status: 'COMPLETED', rawScore: 0.99 })).toBe(
    false,
  );
});

it('does not issue a test verdict in ordinary builds or for remote/non-HTTP origins', () => {
  const result = { status: 'COMPLETED', rawScore: 0.999 } as const;
  expect(localTestDecision(false, loopback, 'image', result)).toBe(false);
  for (const url of [
    'https://example.com',
    'https://localhost/',
    'http://localhost.example.org',
    'http://127.0.0.1.example.org',
    'http://localhost@evil.example',
    'file:///tmp/image.png',
    'http://u:p@localhost',
    undefined,
  ]) {
    expect(localTestDecision(true, url, 'image', result)).toBe(false);
  }
  expect(localTestDecision(true, 'http://localhost:8765/', 'image', result)).toBe(true);
});

it('does not turn failed, canceled, unsupported, missing or invalid scores into labels', () => {
  for (const status of ['FAILED', 'UNSUPPORTED', 'CANCELED'] as const) {
    expect(localTestDecision(true, loopback, 'image', { status, rawScore: 0.9 })).toBe(false);
  }
  for (const rawScore of [undefined, Number.NaN, Infinity, -0.5, 1.01]) {
    expect(localTestDecision(true, loopback, 'image', { status: 'COMPLETED', rawScore })).toBe(
      false,
    );
  }
});

it('automatically admits loopback pages only in a local test build', async () => {
  vi.stubGlobal('__LABEL_AI_LOCAL_TEST__', true);
  vi.resetModules();
  const { isEligiblePage, normalizeSettings, normalizeOrigin, DEFAULT_SETTINGS } = await import(
    '../src/core/policy'
  );
  const settings = DEFAULT_SETTINGS;
  expect(isEligiblePage(loopback, settings)).toBe(true);
  expect(isEligiblePage('http://127.0.0.1:8766/', settings)).toBe(true);
  expect(isEligiblePage('https://news.example/article', settings)).toBe(false);
  expect(isEligiblePage(loopback, { ...settings, enabled: false })).toBe(false);
  expect(isEligiblePage(loopback, settings, true)).toBe(false);
  expect(normalizeOrigin('https://news.example')).toBeNull();
  expect(normalizeSettings({ ...settings, approvedOrigins: ['https://news.example'] })).toEqual(
    settings,
  );
});
