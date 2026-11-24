import { createProvenanceVerifier } from '../../src/index.ts';
import wasmUrl from '@contentauth/c2pa-wasm/c2pa.wasm?url';

const verifier = createProvenanceVerifier({ wasmUrl, timeoutMs: 15_000 });
Object.assign(window, {
  verifyFixture: async (base64: string, mime: string, representation = 'ORIGINAL_FILE') => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return verifier.verify(new Blob([bytes], { type: mime }), { representation: representation as 'ORIGINAL_FILE' });
  },
  closeVerifier: () => verifier.dispose(),
});
