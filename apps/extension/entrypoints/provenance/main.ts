import { browser } from 'wxt/browser';
import { createProvenanceVerifier } from '@label-ai/provenance';
import { decodeBase64, MAX_ORIGINAL_BYTES } from '../../src/core/protocol';

const verifier = createProvenanceVerifier({ wasmUrl: new URL('c2pa/c2pa_bg.wasm', browser.runtime.getURL('/provenance.html')).href });
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.target !== 'label-ai-provenance' || message.type !== 'verify') return;
  if (sender.id !== browser.runtime.id || sender.tab || !message.original || !/^image\/(jpeg|png|webp|avif)$/.test(message.original.mime)) return;
  return (async () => {
    try {
      const bytes = decodeBase64(message.original.base64, MAX_ORIGINAL_BYTES);
      return await verifier.verify(new Blob([bytes], { type: message.original.mime }), { representation: 'ORIGINAL_FILE' });
    } catch { return { shouldLabel: false, policyVersion: 'unavailable' }; }
  })();
});
window.addEventListener('pagehide', () => verifier.dispose(), { once: true });
