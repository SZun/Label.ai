import { sigmoid, validateRgba, type RgbaInput } from './preprocess.ts';
export type ScoredFrame = RgbaInput & { timestampMs: number; logit: number };
export const TEMPORAL_FEATURE_VERSION = 'luma32-consecutive-difference2-logit-distribution-v1';
export const MAX_VIDEO_FRAMES = 12;
export type TemporalEvidence = {
  sustainedFrameEvidence: boolean; coverage: number; denseTriplets: number; sceneCuts: number; motionEnergy: number;
  secondOrderResidual: number; scoreQuantile25: number; eligible: boolean; reasonCodes: string[];
  meanLogit: number; lowerQuartileLogit: number; logitStd: number; logitTemporalDelta: number;
  frameCount: number; sampleSpanMs: number;
};

function quantile25(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) / 4;
  const index = Math.floor(position), weight = position - index;
  return sorted[index]! * (1 - weight) + sorted[Math.min(sorted.length - 1, index + 1)]! * weight;
}

function lumaGrid(frame: ScoredFrame): Float32Array {
  const output = new Float32Array(32 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const px = Math.floor((x + 0.5) * frame.width / 32);
    const py = Math.floor((y + 0.5) * frame.height / 32);
    const i = (py * frame.width + px) * 4;
    const alpha = frame.rgba[i + 3]! / 255;
    output[y * 32 + x] = (0.2126 * frame.rgba[i]! + 0.7152 * frame.rgba[i + 1]! +
      0.0722 * frame.rgba[i + 2]!) / 255 * alpha + (1 - alpha);
  }
  return output;
}

/** Spatial frame inference plus actual first/second order temporal features.
 * These are evidence features, not an independently validated video classifier.
 * Sample support is bounded to +/- 750ms; distant endpoints cannot invent coverage.
 */
export function analyzeTemporalEvidence(frames: ScoredFrame[], durationMs: number): TemporalEvidence {
  if (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > 24 * 60 * 60 * 1000) {
    throw new RangeError('Video duration must be finite, positive, and at most 24 hours');
  }
  if (frames.length < 1 || frames.length > MAX_VIDEO_FRAMES) throw new RangeError('Video input requires 1 to 12 frames');
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    validateRgba(frame, 'video');
    if (!Number.isFinite(frame.logit)) throw new RangeError('Frame logit must be finite');
    if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs > durationMs ||
        (i > 0 && frame.timestampMs <= frames[i - 1]!.timestampMs)) {
      throw new RangeError('Frame timestamps must be distinct, increasing, and within duration');
    }
  }
  const maxGap = Math.min(1500, durationMs / 6);
  let coveredMs = 0, previousEnd = 0;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const hasPreviousNeighbor = i > 0 && frame.timestampMs - frames[i - 1]!.timestampMs <= maxGap;
    const hasNextNeighbor = i + 1 < frames.length && frames[i + 1]!.timestampMs - frame.timestampMs <= maxGap;
    if (!hasPreviousNeighbor && !hasNextNeighbor) continue;
    const start = Math.max(0, frame.timestampMs - maxGap / 2);
    const end = Math.min(durationMs, frame.timestampMs + maxGap / 2);
    coveredMs += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = end;
  }
  const coverage = Math.min(1, coveredMs / durationMs);
  const grids = frames.map(lumaGrid);
  let motionSum = 0, residualSum = 0, densePairs = 0, denseTriplets = 0, sceneCuts = 0, logitDelta = 0;
  for (let i = 1; i < frames.length; i++) {
    const gap = frames[i]!.timestampMs - frames[i - 1]!.timestampMs;
    if (gap > maxGap) continue;
    densePairs++;
    const a = grids[i - 1]!, b = grids[i]!;
    let difference = 0;
    for (let p = 0; p < b.length; p++) difference += Math.abs(b[p]! - a[p]!);
    difference /= b.length;
    motionSum += difference;
    if (difference > 0.25) sceneCuts++;
    logitDelta += Math.abs(frames[i]!.logit - frames[i - 1]!.logit) / Math.max(0.1, gap / 1000);
    if (i < 2) continue;
    const previousGap = frames[i - 1]!.timestampMs - frames[i - 2]!.timestampMs;
    if (previousGap > maxGap) continue;
    denseTriplets++;
    const previous = grids[i - 2]!, ratio = gap / previousGap;
    for (let p = 0; p < b.length; p++) {
      residualSum += Math.abs((b[p]! - a[p]!) - (a[p]! - previous[p]!) * ratio) / (1 + ratio) / b.length;
    }
  }
  // Store only a summary; frame scores never leave the local inference engine.
  const thirds = Array.from({ length: 3 }, () => ({ total: 0, positive: 0 }));
  for (const frame of frames) {
    const third = thirds[Math.min(2, Math.floor(3 * frame.timestampMs / durationMs))]!;
    third.total++;
    if (sigmoid(frame.logit) >= 0.10) third.positive++;
  }
  const sustainedFrameEvidence = thirds.every(({ positive, total }) => positive >= 2 && positive * 2 > total);
  const logits = frames.map(frame => frame.logit);
  const meanLogit = logits.reduce((sum, value) => sum + value, 0) / logits.length;
  const lowerQuartileLogit = quantile25(logits);
  const motionEnergy = densePairs ? motionSum / densePairs : 0;
  const reasonCodes: string[] = [];
  if (frames.length < 8 || denseTriplets < 4) reasonCodes.push('INSUFFICIENT_TEMPORAL_SAMPLES');
  if (coverage < 0.8) reasonCodes.push('INSUFFICIENT_TEMPORAL_COVERAGE');
  if (motionEnergy < 1 / 1024) reasonCodes.push('NO_TEMPORAL_CHANGE');
  if (Math.min(...logits) < 0 && Math.max(...logits) > 0) reasonCodes.push('MIXED_FRAME_EVIDENCE');
  if (sceneCuts > Math.max(1, Math.floor(densePairs / 4))) reasonCodes.push('EXCESSIVE_SCENE_DISCONTINUITY');
  return {
    sustainedFrameEvidence, coverage, denseTriplets, sceneCuts, motionEnergy,
    secondOrderResidual: denseTriplets ? residualSum / denseTriplets : 0,
    scoreQuantile25: sigmoid(lowerQuartileLogit),
    eligible: reasonCodes.length === 0, reasonCodes,
    meanLogit, lowerQuartileLogit,
    logitStd: Math.sqrt(logits.reduce((sum, value) => sum + (value - meanLogit) ** 2, 0) / logits.length),
    logitTemporalDelta: densePairs ? logitDelta / densePairs : 0,
    frameCount: frames.length,
    sampleSpanMs: frames.at(-1)!.timestampMs - frames[0]!.timestampMs,
  };
}
