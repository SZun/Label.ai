import { MODEL } from './model.ts';
import { approveRoute, DEFAULT_POLICY, scoreImage, scoreVideo, type LocalPolicy } from './policy.ts';
import { checkCanceled, preprocessRgba, sigmoid, type RgbaInput } from './preprocess.ts';
import { analyzeTemporalEvidence, type TemporalEvidence } from './temporal.ts';
export type LocalResult = {
  status: 'COMPLETED' | 'UNSUPPORTED' | 'FAILED' | 'CANCELED';
  shouldLabel: boolean;
  classification: 'AI_GENERATED' | 'UNCERTAIN' | 'UNKNOWN';
  reasonCodes: string[];
  policyVersion: string;
  modelVersion: string;
  score?: number;
  rawScore?: number;
  logit?: number;
  temporal?: TemporalEvidence;
};
export type VideoFramesInput = {
  frames: Array<RgbaInput & { timestampMs: number }>;
  durationMs: number;
  coverage?: number;
  signal?: AbortSignal;
};
export type InferenceRunner = { run(input: Float32Array): Promise<number>; dispose(): Promise<void> };
export function createDetectorEngine(runner: InferenceRunner, inputPolicy: LocalPolicy = DEFAULT_POLICY): {
  analyzeRgba(input: RgbaInput): Promise<LocalResult>;
  analyzeVideoFrames(input: VideoFramesInput): Promise<LocalResult>;
  dispose(): Promise<void>;
} {
  // Snapshot configuration once. A caller cannot mutate thresholds while a job is queued.
  const policy = structuredClone(inputPolicy);
  let queue = Promise.resolve();
  let disposal: Promise<void> | undefined;
  let disposed = false;
  let pending = 0;

  function result(status: LocalResult['status'], reasonCodes: string[]): LocalResult {
    return { status, shouldLabel: false, classification: status === 'COMPLETED' ? 'UNCERTAIN' : 'UNKNOWN',
      reasonCodes, policyVersion: policy.version, modelVersion: MODEL.id };
  }

  function failure(error: unknown): LocalResult {
    if (error instanceof Error && error.name === 'AbortError') return result('CANCELED', ['ANALYSIS_CANCELED']);
    if (error instanceof RangeError) return result('UNSUPPORTED', ['INVALID_OR_UNSUPPORTED_INPUT']);
    return result('FAILED', ['LOCAL_INFERENCE_FAILED']);
  }

  function enqueue(operation: () => Promise<LocalResult>): Promise<LocalResult> {
    if (disposed) return Promise.resolve(result('FAILED', ['DETECTOR_DISPOSED']));
    if (pending >= 2) return Promise.resolve(result('FAILED', ['LOCAL_QUEUE_FULL']));
    pending++;
    const job = queue.then(operation).catch(failure).finally(() => { pending--; });
    queue = job.then(() => {});
    return job;
  }

  async function run(input: RgbaInput, kind: 'image' | 'video'): Promise<number> {
    checkCanceled(input.signal);
    const tensor = preprocessRgba(input, kind);
    const logit = await runner.run(tensor);
    checkCanceled(input.signal);
    if (!Number.isFinite(logit)) throw new TypeError('Nonfinite model output');
    return logit;
  }

  return {
    analyzeRgba(input) {
      return enqueue(async () => {
        const logit = await run(input, 'image');
        if (Math.min(input.width, input.height) < 128) {
          // Existing release evidence and calibration predate this preview-only size range.
          return { ...result('COMPLETED', ['LOCAL_IMAGE_MODEL', 'NARROW_THUMBNAIL_PREVIEW', 'SCORE_UNCALIBRATED']),
            logit, rawScore: sigmoid(logit) };
        }
        const score = scoreImage(logit, policy.image.calibration);
        const approved = approveRoute(policy, 'image');
        const reasons = ['LOCAL_IMAGE_MODEL'];
        if (!approved) reasons.push('IMAGE_ROUTE_UNVALIDATED');
        if (!policy.image.calibration) reasons.push('SCORE_UNCALIBRATED');
        const shouldLabel = approved && score >= policy.image.threshold;
        return { ...result('COMPLETED', reasons), shouldLabel, classification: shouldLabel ? 'AI_GENERATED' : 'UNCERTAIN',
          logit, rawScore: sigmoid(logit), score };
      });
    },
    analyzeVideoFrames(input) {
      return enqueue(async () => {
        checkCanceled(input.signal);
        // Validate ordering, count, dense coverage and actual change before expensive model work.
        const initial = analyzeTemporalEvidence(input.frames.map(frame => ({ ...frame, logit: 0 })), input.durationMs);
        if (!initial.eligible) return { ...result('COMPLETED', initial.reasonCodes), temporal: initial };
        const scoredFrames = [];
        for (const frame of input.frames) {
          checkCanceled(input.signal);
          const logit = await run({ ...frame, ...(input.signal ? { signal: input.signal } : {}) }, 'video');
          scoredFrames.push({ ...frame, logit });
          // Native WASM may finish its Promise synchronously. Yield a task so
          // cancel messages and deadline timers run before another costly frame.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          checkCanceled(input.signal);
        }
        const temporal = analyzeTemporalEvidence(scoredFrames, input.durationMs);
        const score = scoreVideo(temporal, policy.video.calibration);
        const approved = approveRoute(policy, 'video');
        const reasons = ['LOCAL_TEMPORAL_FEATURES', ...temporal.reasonCodes];
        if (!approved) reasons.push('VIDEO_ROUTE_UNVALIDATED');
        if (score === undefined) reasons.push('TEMPORAL_MODEL_NOT_CALIBRATED');
        const shouldLabel = approved && temporal.eligible && score !== undefined && score >= policy.video.threshold;
        return { ...result('COMPLETED', reasons), shouldLabel, classification: shouldLabel ? 'AI_GENERATED' : 'UNCERTAIN',
          temporal, rawScore: temporal.scoreQuantile25, ...(score === undefined ? {} : { score }) };
      });
    },
    dispose() {
      if (!disposal) {
        disposed = true;
        disposal = queue.then(() => runner.dispose());
      }
      return disposal;
    },
  };
}
