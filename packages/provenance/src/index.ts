import { provenanceResult, type ProvenanceResult } from './policy.ts';
import { validatePackagedAssetUrl } from './guards.ts';
import { offlineTrustSettings, PROVENANCE_POLICY_VERSION, PROVENANCE_TRUST_EXPIRES_AT } from './trust.ts';
import { initializeWasm, verifyBytes } from './wasm.ts';
import { WASM_SRI } from '@contentauth/c2pa-wasm';
export type { ProvenanceResult, ProvenanceStatus } from './policy.ts';
export { PROVENANCE_POLICY_VERSION, PROVENANCE_TRUST_EXPIRES_AT } from './trust.ts';

export interface ProvenanceOptions {
  readonly wasmUrl: string;
  readonly timeoutMs?: number;
}

export interface VerifyOptions {
  readonly representation: 'ORIGINAL_FILE' | 'FRAME_SEQUENCE' | 'RENDERED_FRAME';
  readonly signal?: AbortSignal;
}

export interface ProvenanceVerifier {
  verify(blob: Blob, options: VerifyOptions): Promise<ProvenanceResult>;
  dispose(): void;
}

const FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'video/mp4', 'video/webm']);
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;

/**
 * Run only in an extension-owned document/worker, never a page main world.
 * The official byte API does not need FileReaderSync or a nested Worker.
 * Original bytes stay local. This module has no URL acquisition or remote-verification path.
 */
export function createProvenanceVerifier(options: ProvenanceOptions): ProvenanceVerifier {
  const wasmUrl = validatePackagedAssetUrl(options.wasmUrl, globalThis.location.href);
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('Invalid provenance timeout');
  }

  let disposed = false;
  let sdk: Promise<void> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let queuedCount = 0;
  let queuedBytes = 0;
  const result = (status: ProvenanceResult['status'], reason: string) =>
    provenanceResult(status, PROVENANCE_POLICY_VERSION, reason);

  function resetRuntime() {
    sdk = undefined;
  }

  async function runtime(): Promise<void> {
    sdk ??= (async () => {
      const response = await fetch(wasmUrl, { integrity: WASM_SRI, credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error('Packaged WASM unavailable');
      await initializeWasm(await WebAssembly.compileStreaming(response));
    })();
    return sdk;
  }

  async function read(blob: Blob): Promise<ProvenanceResult> {
    try {
      await runtime();
    } catch {
      resetRuntime();
      return result('unavailable', 'C2PA_RUNTIME_UNAVAILABLE');
    }
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return await verifyBytes(bytes, blob.type, offlineTrustSettings(), PROVENANCE_POLICY_VERSION);
    } catch {
      // Never expose SDK exception strings: malformed metadata can contain arbitrary private text.
      return result('invalid', 'C2PA_READING_FAILED');
    }
  }

  async function run(blob: Blob, signal?: AbortSignal): Promise<ProvenanceResult> {
    if (disposed || signal?.aborted) return result('unavailable', 'C2PA_CANCELED');
    if (Date.now() >= Date.parse(PROVENANCE_TRUST_EXPIRES_AT)) {
      return result('unavailable', 'C2PA_TRUST_SNAPSHOT_EXPIRED');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const started = performance.now();
    const interruption = new Promise<ProvenanceResult>((resolve) => {
      abort = () => {
        resetRuntime();
        resolve(result('unavailable', 'C2PA_CANCELED'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        resetRuntime();
        resolve(result('unavailable', 'C2PA_TIMEOUT'));
      }, timeoutMs);
    });
    try {
      const answer = await Promise.race([read(blob), interruption]);
      // Wasm parsing can occupy this context synchronously; never accept an overdue result
      // merely because the timer callback could not run until parsing finished.
      if (performance.now() - started > timeoutMs) return result('unavailable', 'C2PA_TIMEOUT');
      return disposed || signal?.aborted ? result('unavailable', 'C2PA_CANCELED') : answer;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }

  return {
    async verify(blob, input) {
      if (disposed || input.signal?.aborted) return result('unavailable', 'C2PA_CANCELED');
      if (input.representation !== 'ORIGINAL_FILE') return result('unsupported', 'C2PA_ORIGINAL_BYTES_REQUIRED');
      if (!FORMATS.has(blob.type)) return result('unsupported', 'C2PA_UNSUPPORTED_FORMAT');
      const limit = blob.type.startsWith('video/') ? 100 * 1024 * 1024 : 15 * 1024 * 1024;
      if (blob.size === 0 || blob.size > limit) return result('unsupported', 'C2PA_SIZE_LIMIT');
      if (queuedCount >= 8 || queuedBytes + blob.size > MAX_QUEUED_BYTES) return result('unavailable', 'C2PA_QUEUE_FULL');
      queuedCount += 1;
      queuedBytes += blob.size;
      const task = queue.then(() => run(blob, input.signal));
      queue = task.then(() => undefined, () => undefined);
      try {
        return await task;
      } finally {
        queuedCount -= 1;
        queuedBytes -= blob.size;
      }
    },
    dispose() {
      disposed = true;
      resetRuntime();
    },
  };
}
