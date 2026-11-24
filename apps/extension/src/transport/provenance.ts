import { browser } from 'wxt/browser';
import { createProvenanceVerifier } from '@label-ai/provenance';
import { decodeBase64, MAX_ORIGINAL_BYTES } from '../core/protocol';

let direct: ReturnType<typeof createProvenanceVerifier> | undefined;

export async function localProvenance(original: { base64: string; mime: string }, signal?: AbortSignal) {
  direct ??= createProvenanceVerifier({ wasmUrl: new URL('c2pa/c2pa_bg.wasm', browser.runtime.getURL('/options.html')).href });
  return direct.verify(new Blob([decodeBase64(original.base64, MAX_ORIGINAL_BYTES)], { type: original.mime }), { representation: 'ORIGINAL_FILE', signal });
}

export async function clearProvenance() {
  if (direct) { direct.dispose(); direct = undefined; }
}
