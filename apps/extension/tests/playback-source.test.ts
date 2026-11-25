import { afterEach, expect, it, vi } from 'vitest';
import { sourceFor } from '../src/media/capture';

afterEach(() => vi.unstubAllGlobals());

it('tracks a worker-backed player without a URL and invalidates a replaced handle', () => {
  class Handle {}
  vi.stubGlobal('MediaSourceHandle', Handle);
  const video = document.createElement('video');
  Object.defineProperty(video, 'srcObject', { writable: true, value: new Handle() });
  const first = sourceFor(video);
  expect(first).toBeTruthy();
  expect(sourceFor(video)).toBe(first);
  Object.defineProperty(video, 'srcObject', { value: new Handle() });
  expect(sourceFor(video)).not.toBe(first);
});

it('rejects camera and unrecognized object streams even when the old URL remains', () => {
  const video = document.createElement('video');
  video.src = 'https://example.org/previous.mp4';
  Object.defineProperty(video, 'srcObject', { value: {} });
  expect(sourceFor(video)).toBe('');
});
