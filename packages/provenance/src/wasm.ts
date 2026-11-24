import init, { WasmReader } from '@contentauth/c2pa-wasm';
import { evaluateManifest, provenanceResult, type ProvenanceResult } from './policy.ts';

/** Use the official byte API: works in browser service workers and Node, without browser API shims. */
export async function initializeWasm(module: WebAssembly.Module): Promise<void> {
  await init({ module_or_path: module });
}

export async function verifyBytes(bytes: Uint8Array, mime: string, settings: string, policyVersion: string): Promise<ProvenanceResult> {
  let reader: WasmReader | undefined;
  try {
    reader = await WasmReader.fromBytes(mime, bytes, settings);
    return evaluateManifest(JSON.parse(reader.json()) as unknown, policyVersion);
  } catch (error: unknown) {
    // Read only the SDK error category; never propagate arbitrary metadata/error text to logs or UI.
    const category = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    const missing = /ManifestNotFound|JumbfNotFound|no JUMBF data found/.test(category);
    return provenanceResult(missing ? 'missing' : 'invalid', policyVersion,
      missing ? 'C2PA_NO_ACTIVE_MANIFEST' : 'C2PA_READING_FAILED');
  } finally {
    reader?.free();
  }
}
