import { browser } from 'wxt/browser';
import { createProvenanceVerifier } from '@label-ai/provenance';
import { decodeBase64, MAX_ORIGINAL_BYTES } from '../core/protocol';

let documentCreation: Promise<void> | undefined;
let direct: ReturnType<typeof createProvenanceVerifier> | undefined;

export async function localProvenance(original: { base64: string; mime: string }) {
  if (typeof document !== 'undefined' && typeof Worker !== 'undefined') {
    direct ??= createProvenanceVerifier({ wasmUrl: new URL('c2pa/c2pa_bg.wasm', browser.runtime.getURL('/provenance.html')).href });
    return direct.verify(new Blob([decodeBase64(original.base64, MAX_ORIGINAL_BYTES)], { type: original.mime }), { representation: 'ORIGINAL_FILE' });
  }
  if (!browser.offscreen?.createDocument) return undefined;
  documentCreation ??= (async () => {
    const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.some((context) => context.documentUrl === browser.runtime.getURL('/provenance.html'))) {
      await browser.offscreen.createDocument({ url: '/provenance.html', reasons: ['WORKERS', 'BLOBS'], justification: 'Verify signed media credentials entirely on this device.' });
    }
  })();
  try { await documentCreation; } catch { documentCreation = undefined; return undefined; }
  return browser.runtime.sendMessage({ target: 'label-ai-provenance', type: 'verify', original });
}

export async function clearProvenance() {
  if (direct) { direct.dispose(); direct = undefined; }
  documentCreation = undefined;
  if (browser.offscreen?.closeDocument) { try { await browser.offscreen.closeDocument(); } catch { /* No document remains. */ } }
}
