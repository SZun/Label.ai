import * as ort from 'onnxruntime-web/wasm';
import { loadPackagedModel, packagedAssetUrl } from './assets.ts';
import { createDetectorEngine, type LocalResult } from './engine.ts';
import { MODEL } from './model.ts';
import { DEFAULT_POLICY, type LocalPolicy } from './policy.ts';
import { checkCanceled, INPUT_SIZE } from './preprocess.ts';

export { MODEL } from './model.ts';
export { DEFAULT_POLICY } from './policy.ts';
export { PREPROCESSING_VERSION } from './preprocess.ts';
export { TEMPORAL_FEATURE_VERSION } from './temporal.ts';
export type { LocalPolicy, PlattCalibration, TemporalCalibration } from './policy.ts';
export type { LocalResult, VideoFramesInput } from './engine.ts';
export type { RgbaInput } from './preprocess.ts';

/** Call inside an extension-owned dedicated worker. Code, weights and WASM are
 * bundled with the extension; this API has no remote model download or provider fallback.
 */
export async function createLocalDetector(options: { assetBaseUrl: string; policy?: LocalPolicy; executionProvider?: 'wasm' }) {
  const { assetBaseUrl, policy = DEFAULT_POLICY } = options;
  if (options.executionProvider && options.executionProvider !== 'wasm') throw new TypeError('Only the verified WASM execution provider is available');
  ort.env.wasm.numThreads = 1; // Works without cross-origin isolation / SharedArrayBuffer, including Safari.
  ort.env.wasm.proxy = false; // We already own a worker; do not create a blob worker under MV3 CSP.
  ort.env.wasm.wasmPaths = {
    wasm: packagedAssetUrl(assetBaseUrl, 'ort-wasm-simd-threaded.wasm'),
    mjs: packagedAssetUrl(assetBaseUrl, 'ort-wasm-simd-threaded.mjs'),
  };
  const bytes = await loadPackagedModel(assetBaseUrl);
  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all', executionMode: 'sequential',
  });
  if (session.inputNames.length !== 1 || session.inputNames[0] !== MODEL.input || !session.outputNames.includes(MODEL.output)) {
    await session.release();
    throw new Error('Packaged model interface mismatch');
  }
  const engine = createDetectorEngine({
    async run(input) {
      const tensor = new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]);
      try {
        const outputs = await session.run({ [MODEL.input]: tensor });
        try {
          const output = outputs[MODEL.output];
          if (!output || output.data.length !== 1 || typeof output.data[0] !== 'number') throw new Error('Invalid inference output');
          return output.data[0];
        } finally { for (const output of Object.values(outputs)) output.dispose(); }
      } finally { tensor.dispose(); }
    },
    dispose: () => session.release(),
  }, policy);

  return {
    ...engine,
    async analyzeImage({ bytes: imageBytes, mime, signal }: { bytes: Uint8Array; mime: string; signal?: AbortSignal }): Promise<LocalResult> {
      const unsupported = (status: LocalResult['status'], code: string): LocalResult => ({
        status, shouldLabel: false, classification: 'UNKNOWN', reasonCodes: [code], policyVersion: policy.version, modelVersion: MODEL.id,
      });
      try {
        checkCanceled(signal);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || imageBytes.byteLength < 12 || imageBytes.byteLength > 8 * 1024 * 1024) {
          return unsupported('UNSUPPORTED', 'IMAGE_ENCODING_OR_SIZE_UNSUPPORTED');
        }
        if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return unsupported('UNSUPPORTED', 'LOCAL_IMAGE_DECODE_UNAVAILABLE');
        const bitmap = await createImageBitmap(new Blob([imageBytes.slice().buffer], { type: mime }));
        try {
          checkCanceled(signal);
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
