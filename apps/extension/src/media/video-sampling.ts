export const VIDEO_MAX_SIDE = 480;
export const MAX_SAMPLED_DURATION_MS = 60_000;

export function videoSamplePlan(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_SAMPLED_DURATION_MS)
    return;
  // Existing slots reach 80% support to about 21s, including frame-timing jitter.
  // Longer videos need multiple independently verified, consecutive windows.
  const segments = durationMs <= 21_000 ? 1 : Math.ceil(durationMs / 18_000);
  return {
    segments,
    segmentDurationMs: durationMs / segments,
    frameLimit: 12 * segments,
    maxSide: Math.floor(VIDEO_MAX_SIDE / Math.sqrt(segments)),
  };
}

// Divide playback into three four-frame sequences. On longer clips, leave a
// gap between sequences so the detector receives motion from each third.
// 1.4s leaves room for frame timing jitter under the 1.5s neighbor limit.
export function videoSampleSlot(timestampMs: number, durationMs: number): number {
  const plan = videoSamplePlan(durationMs);
  if (!plan || !Number.isFinite(timestampMs) || timestampMs < 0 || timestampMs >= durationMs)
    return -1;
  const segment = Math.min(plan.segments - 1, Math.floor(timestampMs / plan.segmentDurationMs));
  const localTime = timestampMs - segment * plan.segmentDurationMs;
  const groupWidth = plan.segmentDurationMs / 3;
  const interval = Math.min(groupWidth / 4, 1400);
  const group = Math.min(2, Math.floor(localTime / groupWidth));
  const firstTarget = group * groupWidth + (groupWidth - 3 * interval) / 2;
  if (localTime < firstTarget) return -1;
  return segment * 12 + group * 4 + Math.min(3, Math.floor((localTime - firstTarget) / interval));
}

export function partitionVideoFrames<T extends { timestampMs: number }>(
  frames: T[],
  durationMs: number,
) {
  const plan = videoSamplePlan(durationMs);
  if (!plan || frames.length > plan.frameLimit) return;
  const parts: T[][] = Array.from({ length: plan.segments }, () => []);
  let previous = -1;
  for (const frame of frames) {
    const time = frame.timestampMs;
    if (!Number.isFinite(time) || time < 0 || time > durationMs || time <= previous) return;
    previous = time;
    const index = Math.min(plan.segments - 1, Math.floor(time / plan.segmentDurationMs));
    parts[index]!.push({ ...frame, timestampMs: time - index * plan.segmentDurationMs });
  }
  if (parts.some((part) => part.length < 3 || part.length > 12)) return;
  return parts;
}
