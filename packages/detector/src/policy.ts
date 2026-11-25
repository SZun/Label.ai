import { MODEL } from './model.ts';
import { PREPROCESSING_VERSION, sigmoid } from './preprocess.ts';
import { TEMPORAL_FEATURE_VERSION, type TemporalEvidence } from './temporal.ts';
export type PlattCalibration = { version: string; slope: number; intercept: number; calibrationSetSha256: string };
export type TemporalCalibration = {
  version: string;
  featureVersion: string;
  calibrationSetSha256: string;
  intercept: number;
  coefficients: Record<'meanLogit' | 'lowerQuartileLogit' | 'logitStd' | 'logitTemporalDelta' | 'motionEnergy' | 'secondOrderResidual' | 'sceneCuts', number>;
};
export type ValidationEvidence = {
  approved: boolean;
  evaluationId: string;
  modelSha256: string;
  preprocessingVersion: string;
  calibrationVersion: string;
  threshold: number;
  manifestSha256: string;
  predictionsSha256: string;
  projectedPrecisionLower95: number;
  fprUpper95: number;
  recall: number;
};
export type RoutePolicy<T> = { enabled: boolean; threshold: number; calibration?: T; evidence?: ValidationEvidence };
export type LocalPolicy = { version: string; image: RoutePolicy<PlattCalibration>; video: RoutePolicy<TemporalCalibration> };
export const DEFAULT_POLICY: LocalPolicy = Object.freeze({ version: 'local-v1-unvalidated', image: Object.freeze({ enabled: false, threshold: 0.99 }), video: Object.freeze({ enabled: false, threshold: 0.99 }) });
const HASH = /^[a-f0-9]{64}$/;

/** Approval is a reviewed build artifact. Nothing from a webpage or a remote
 * configuration endpoint is allowed to populate this policy. These consistency
 * checks supplement human review; they cannot prove that a fabricated report is real.
 */
export function approveRoute(policy: LocalPolicy, modality: 'image' | 'video'): boolean {
  const route = policy[modality];
  const evidence = route.evidence;
  const calibration = route.calibration;
  if (!route.enabled || !evidence?.approved || !calibration || !policy.version || !evidence.evaluationId) return false;
  if (evidence.modelSha256 !== MODEL.sha256 || evidence.preprocessingVersion !== PREPROCESSING_VERSION ||
      evidence.calibrationVersion !== calibration.version || evidence.threshold !== route.threshold) return false;
  if (![evidence.manifestSha256, evidence.predictionsSha256, calibration.calibrationSetSha256].every(hash => HASH.test(hash)) ||
      evidence.manifestSha256 === calibration.calibrationSetSha256) return false;
  if (![route.threshold, evidence.projectedPrecisionLower95, evidence.fprUpper95, evidence.recall].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return false;
  if (route.threshold < 0.5 || evidence.projectedPrecisionLower95 < 0.99 || evidence.fprUpper95 > 0.001 || evidence.recall < 0.5) return false;
  try {
    if (modality === 'image') scoreImage(0, policy.image.calibration);
    else validateTemporalCalibration(policy.video.calibration!);
  } catch { return false; }
  return true;
}

export function scoreImage(logit: number, calibration?: PlattCalibration): number {
  if (!calibration) return sigmoid(logit);
  if (!Number.isFinite(calibration.slope) || calibration.slope <= 0 || !Number.isFinite(calibration.intercept) ||
      !calibration.version || !HASH.test(calibration.calibrationSetSha256)) throw new TypeError('Invalid image calibration');
  return sigmoid(calibration.slope * logit + calibration.intercept);
}

export const TEMPORAL_FEATURES = ['meanLogit', 'lowerQuartileLogit', 'logitStd', 'logitTemporalDelta', 'motionEnergy', 'secondOrderResidual', 'sceneCuts'] as const;

function validateTemporalCalibration(calibration: TemporalCalibration): void {
  if (!calibration || !calibration.version || calibration.featureVersion !== TEMPORAL_FEATURE_VERSION ||
      !HASH.test(calibration.calibrationSetSha256) || !Number.isFinite(calibration.intercept) ||
      !TEMPORAL_FEATURES.every(key => Number.isFinite(calibration.coefficients?.[key]))) {
    throw new TypeError('Invalid temporal calibration');
  }
  // A frame-score-only fit is not a temporal model. At least one real dynamics feature must contribute.
  if (!['motionEnergy', 'secondOrderResidual', 'logitTemporalDelta'].some(key => Math.abs(calibration.coefficients[key as typeof TEMPORAL_FEATURES[number]]) > 1e-10)) {
    throw new TypeError('Temporal calibration does not use temporal evidence');
  }
}

export function scoreVideo(evidence: TemporalEvidence, calibration?: TemporalCalibration): number | undefined {
  if (!calibration) return undefined;
  validateTemporalCalibration(calibration);
  let logit = calibration.intercept;
  for (const key of TEMPORAL_FEATURES) {
    if (!Number.isFinite(evidence[key])) throw new TypeError('Invalid temporal feature');
    logit += evidence[key] * calibration.coefficients[key];
  }
  return sigmoid(logit);
}
