// The detector credits at most 1.5 seconds per frame and requires 80% coverage.
// Longer clips cannot qualify within the 12-frame memory budget.
export const MAX_SAMPLED_DURATION_MS = (12 * 1500) / 0.8;

// Divide playback into three four-frame sequences. On longer clips, leave a
// gap between sequences so the detector receives motion from each third.
// 1.4s leaves room for frame timing jitter under the 1.5s neighbor limit.
export function videoSampleSlot(timestampMs: number, durationMs: number): number {
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    durationMs > MAX_SAMPLED_DURATION_MS ||
    !Number.isFinite(timestampMs) ||
    timestampMs < 0 ||
    timestampMs >= durationMs
  )
    return -1;
  const groupWidth = durationMs / 3;
  const interval = Math.min(groupWidth / 4, 1400);
  const group = Math.min(2, Math.floor(timestampMs / groupWidth));
  const firstTarget = group * groupWidth + (groupWidth - 3 * interval) / 2;
  if (timestampMs < firstTarget) return -1;
  return group * 4 + Math.min(3, Math.floor((timestampMs - firstTarget) / interval));
}
