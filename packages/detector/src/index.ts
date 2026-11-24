import { loadPackagedModel, loadPackagedWasm } from './assets.ts';
import { type LocalResult } from './engine.ts';
import { createWasmEngine } from './session.ts';
import { inspectBoundedPng } from './encoding.ts';
import { MODEL } from './model.ts';
import { DEFAULT_POLICY, type LocalPolicy } from './policy.ts';
import { checkCanceled } from './preprocess.ts';

export { MODEL } from './model.ts';
export { DEFAULT_POLICY } from './policy.ts';
export { PREPROCESSING_VERSION } from './preprocess.ts';
export { TEMPORAL_FEATURE_VERSION } from './temporal.ts';
export type { LocalPolicy, PlattCalibration, TemporalCalibration } from './policy.ts';
export type { LocalResult, VideoFramesInput } from './engine.ts';
export type { RgbaInput } from './preprocess.ts';

/** Call inside an extension-owned background worker. Code, weights and WASM are
 * bundled with the extension; this API has no remote model download or provider fallback.
 */
export async function createLocalDetector(options: { assetBaseUrl: string; policy?: LocalPolicy; executionProvider?: 'wasm' }) {
  const { assetBaseUrl, policy = DEFAULT_POLICY } = options;
  if (options.executionProvider && options.executionProvider !== 'wasm') throw new TypeError('Only the verified WASM execution provider is available');
  // The pinned package embeds its WASM JS glue. The binary bytes come only from
  // the current extension package; no dynamic worker or remote fallback is needed.
  const [bytes, wasm] = await Promise.all([loadPackagedModel(assetBaseUrl), loadPackagedWasm(assetBaseUrl)]);
  const engine = await createWasmEngine(bytes, wasm, policy);

  return {
    ...engine,
    async analyzeImage({ bytes: imageBytes, mime, signal }: { bytes: Uint8Array; mime: string; signal?: AbortSignal }): Promise<LocalResult> {
      const unsupported = (status: LocalResult['status'], code: string): LocalResult => ({
        status, shouldLabel: false, classification: 'UNKNOWN', reasonCodes: [code], policyVersion: policy.version, modelVersion: MODEL.id,
      });
      try {
        checkCanceled(signal);
        if (mime !== 'image/png') {
          return unsupported('UNSUPPORTED', 'IMAGE_ENCODING_OR_SIZE_UNSUPPORTED');
        }
        const dimensions = inspectBoundedPng(imageBytes);
        if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return unsupported('UNSUPPORTED', 'LOCAL_IMAGE_DECODE_UNAVAILABLE');
        const bitmap = await createImageBitmap(new Blob([imageBytes.slice().buffer], { type: mime }));
        try {
          checkCanceled(signal);
          if (bitmap.width !== dimensions.width || bitmap.height !== dimensions.height) return unsupported('UNSUPPORTED', 'IMAGE_DIMENSION_MISMATCH');
          const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
          const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) return unsupported('UNSUPPORTED', 'LOCAL_IMAGE_DECODE_UNAVAILABLE');
          context.drawImage(bitmap, 0, 0, width, height);
          const rgba = context.getImageData(0, 0, width, height).data;
          return engine.analyzeRgba({ rgba, width, height, ...(signal ? { signal } : {}) });
        } finally { bitmap.close(); }
      } catch (error) {
        return unsupported(error instanceof Error && error.name === 'AbortError' ? 'CANCELED' : 'UNSUPPORTED', 'IMAGE_DECODE_FAILED');
      }
    },
  };
}
