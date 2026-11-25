import { expect, it } from 'vitest';
import { analyzeTemporalEvidence } from '../../../packages/detector/src/temporal';
import {
  partitionVideoFrames,
  videoSamplePlan,
  videoSampleSlot,
} from '../src/media/video-sampling';

function playback(durationMs: number, fps: number, startMs = 0) {
  const frames = [];
  let previousSlot = -1;
  for (let frame = 0; ; frame++) {
    const timestampMs = startMs + (frame * 1000) / fps;
    if (timestampMs >= durationMs) break;
    const slot = videoSampleSlot(timestampMs, durationMs);
    if (slot <= previousSlot) continue;
    previousSlot = slot;
    const shade = (slot % 12) * 8;
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
  for (const duration of [0, NaN, Infinity, 60_001, 300_000]) {
    expect(videoSampleSlot(1000, duration)).toBe(-1);
  }
  for (const timestamp of [-1, NaN, Infinity, 4000]) {
    expect(videoSampleSlot(timestamp, 4000)).toBe(-1);
  }
});

it.each([
  [30_000, 2],
  [45_000, 3],
  [60_000, 4],
])('covers every consecutive portion of a %ims clip', (duration, count) => {
  const frames = playback(duration, 24);
  expect(frames).toHaveLength(count * 12);
  const width = duration / count;
  for (let index = 0; index < count; index++) {
    const segment = frames.slice(index * 12, (index + 1) * 12).map((frame) => ({
      ...frame,
      timestampMs: frame.timestampMs - index * width,
    }));
    expect(analyzeTemporalEvidence(segment, width).eligible).toBe(true);
  }
});

it('holds the same total canvas pixel budget when long playback requires more evidence', () => {
  for (const duration of [5000, 32_000, 45_000, 60_000]) {
    const plan = videoSamplePlan(duration)!;
    expect(plan.frameLimit * plan.maxSide ** 2).toBeLessThanOrEqual(12 * 480 ** 2);
    expect(Math.floor((plan.maxSide * 9) / 16)).toBeGreaterThanOrEqual(128);
  }
});

it('rejects absent windows, duplicate timestamps and out-of-order frames before inference', () => {
  const frames = playback(32000, 24);
  const grouped = partitionVideoFrames(frames, 32000)!;
  expect(grouped.map((part) => part.length)).toEqual([12, 12]);
  expect(partitionVideoFrames(frames.slice(12), 32000)).toBeUndefined();
  expect(partitionVideoFrames([...frames.slice(1), frames[0]!], 32000)).toBeUndefined();
  expect(partitionVideoFrames([frames[0]!, ...frames.slice(0, -1)], 32000)).toBeUndefined();
});
