import { expect, it } from 'vitest';
import { analyzeTemporalEvidence } from '../../../packages/detector/src/temporal';
import { videoSampleSlot } from '../src/media/video-sampling';

function playback(durationMs: number, fps: number, startMs = 0) {
  const frames = [];
  let previousSlot = -1;
  for (let frame = 0; ; frame++) {
    const timestampMs = startMs + (frame * 1000) / fps;
    if (timestampMs >= durationMs) break;
    const slot = videoSampleSlot(timestampMs, durationMs);
    if (slot <= previousSlot) continue;
    previousSlot = slot;
    const shade = slot * 8;
    const rgba = new Uint8Array(128 * 128 * 4).fill(shade);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    frames.push({
      width: 128,
      height: 128,
      rgba,
      timestampMs,
      logit: 1,
    });
  }
  return frames;
}

it.each([
  [1000, 30],
  [6000, 25],
  [16000, 24],
  [20000, 30],
  [21000, 15],
])(
  'samples the full %ims clip at %i fps and passes the detector’s temporal gates',
  (durationMs, fps) => {
    const frames = playback(durationMs, fps);
    expect(frames.length).toBe(12);
    expect(frames.at(-1)!.timestampMs).toBeGreaterThan(durationMs * 0.9);
    expect(analyzeTemporalEvidence(frames, durationMs).eligible).toBe(true);
  },
);

it('leaves late starts and sparse motion samples below the existing coverage gate', () => {
  expect(analyzeTemporalEvidence(playback(20000, 30, 9000), 20000).eligible).toBe(false);
  expect(analyzeTemporalEvidence(playback(20000, 0.6), 20000).eligible).toBe(false);
});

it('does not sample unsupported durations or timestamps outside the current clip', () => {
  for (const duration of [0, NaN, Infinity, 22_501, 300_000]) {
    expect(videoSampleSlot(1000, duration)).toBe(-1);
  }
  for (const timestamp of [-1, NaN, Infinity, 4000]) {
    expect(videoSampleSlot(timestamp, 4000)).toBe(-1);
  }
});
