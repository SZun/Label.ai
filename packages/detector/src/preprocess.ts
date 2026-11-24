export const INPUT_SIZE = 384;
export const PREPROCESSING_VERSION = 'rgb-white-bilinear440-center384-imagenet-v1';
export type RgbaInput = { rgba: Uint8Array | Uint8ClampedArray; width: number; height: number; signal?: AbortSignal };

const MAX_INPUT_PIXELS = 1024 * 1024;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

export function checkCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Analysis aborted', 'AbortError');
}

export function validateRgba({ rgba, width, height, signal }: RgbaInput): void {
  checkCanceled(signal);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 128 || height < 128 ||
      width > 1024 || height > 1024 || width * height > MAX_INPUT_PIXELS) {
    throw new RangeError('Input dimensions must be integers between 128 and 1024');
  }
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length !== width * height * 4) {
    throw new RangeError('RGBA input size does not match dimensions');
  }
}

function channel(rgba: Uint8Array | Uint8ClampedArray, index: number, color: number): number {
  const alpha = rgba[index + 3]! / 255;
  return rgba[index + color]! * alpha + 255 * (1 - alpha);
}

/** Deterministic bilinear resize/crop. This exact transform is versioned for calibration.
 * It never mutates caller data and has no browser, URL, filename, or metadata dependencies.
 */
export function preprocessRgba(input: RgbaInput): Float32Array {
  validateRgba(input);
  const { rgba, width, height, signal } = input;
  const scale = 440 / Math.min(width, height);
  const resizedWidth = Math.round(width * scale);
  const resizedHeight = Math.round(height * scale);
  const cropX = Math.floor((resizedWidth - INPUT_SIZE) / 2);
  const cropY = Math.floor((resizedHeight - INPUT_SIZE) / 2);
  const plane = INPUT_SIZE * INPUT_SIZE;
  const output = new Float32Array(plane * 3);

  for (let y = 0; y < INPUT_SIZE; y++) {
    if (y % 32 === 0) checkCanceled(signal);
    const sourceY = Math.max(0, Math.min(height - 1, (y + cropY + 0.5) * height / resizedHeight - 0.5));
    const y0 = Math.floor(sourceY), y1 = Math.min(height - 1, y0 + 1), wy = sourceY - y0;
    for (let x = 0; x < INPUT_SIZE; x++) {
      const sourceX = Math.max(0, Math.min(width - 1, (x + cropX + 0.5) * width / resizedWidth - 0.5));
      const x0 = Math.floor(sourceX), x1 = Math.min(width - 1, x0 + 1), wx = sourceX - x0;
      const a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4;
      const c = (y1 * width + x0) * 4, d = (y1 * width + x1) * 4;
      for (let color = 0; color < 3; color++) {
        const top = channel(rgba, a, color) * (1 - wx) + channel(rgba, b, color) * wx;
        const bottom = channel(rgba, c, color) * (1 - wx) + channel(rgba, d, color) * wx;
        output[color * plane + y * INPUT_SIZE + x] = ((top * (1 - wy) + bottom * wy) / 255 - MEAN[color]!) / STD[color]!;
      }
    }
  }
  return output;
}

export function sigmoid(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('Inference logit must be finite');
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}
