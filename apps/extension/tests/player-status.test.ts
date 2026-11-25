import { expect, it } from 'vitest';
import { playerStatus } from '../src/core/player-status';

it('separates an unavailable player, an in-progress scan and a completed negative', () => {
  const video = document.createElement('video');
  expect(playerStatus(video, undefined, false)).toBe('play');
  expect(playerStatus(video, 'pending', true)).toBe('analyzing');
  expect(playerStatus(video, 'completed-no-label', false)).toBe('below-threshold');
  expect(playerStatus(video, 'unsupported', false)).toBe('unreadable');
  expect(playerStatus(video, 'failed', false)).toBe('failed');
  Object.defineProperty(video, 'mediaKeys', { value: {} });
  expect(playerStatus(video, 'pending', true)).toBe('protected');
});

it('explains when the site is decoding behind an invisible playback surface', () => {
  const video = document.createElement('video');
  expect(playerStatus(video, undefined, false, false)).toBe('hidden-player');
});
