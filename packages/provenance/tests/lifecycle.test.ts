import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import test, { after } from 'node:test';
import { WasmReader } from '@contentauth/c2pa-wasm';

// Supply Vite's static ?raw import convention to Node. The production module and
// genuine WASM engine are otherwise imported unchanged; no test roots or runtime
// bypass are exposed by the package.
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.pem?raw')) {
      const file = new URL(url);
      file.search = '';
      return { format: 'module', shortCircuit: true,
        source: `export default ${JSON.stringify(readFileSync(file, 'utf8'))};` };
    }
    return nextLoad(url, context);
  },
});
const { createProvenanceVerifier, PROVENANCE_TRUST_EXPIRES_AT } = await import('../src/index.ts');
const require = createRequire(import.meta.url);
const wasm = readFileSync(require.resolve('@contentauth/c2pa-wasm/c2pa.wasm'));
const original = readFileSync(new URL('../../../tests/fixtures/provenance/firefly-generated.jpg', import.meta.url));
const savedFetch = globalThis.fetch;
const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'chrome-extension://label-ai/background.js' } });
const verifier = () => createProvenanceVerifier({ wasmUrl: 'chrome-extension://label-ai/c2pa/c2pa_bg.wasm' });
const response = () => new Response(wasm, { headers: { 'Content-Type': 'application/wasm' } });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

after(() => {
  hooks.deregister();
  globalThis.fetch = savedFetch;
  if (savedLocation) Object.defineProperty(globalThis, 'location', savedLocation);
  else Reflect.deleteProperty(globalThis, 'location');
});

test('canceling a pending WASM load aborts its request and prevents late compilation', async () => {
  const fetched = deferred<void>();
  const loaded = deferred<Response>();
  let requestSignal: AbortSignal | undefined;
  let compilations = 0;
  const compile = WebAssembly.compileStreaming;
  WebAssembly.compileStreaming = async (source) => { compilations += 1; return compile(source); };
  globalThis.fetch = async (_url, options) => {
    requestSignal = options?.signal ?? undefined;
    fetched.resolve();
    return loaded.promise;
  };
  const instance = verifier();
  const controller = new AbortController();
  try {
    const work = instance.verify(new Blob([original], { type: 'image/jpeg' }), { representation: 'ORIGINAL_FILE', signal: controller.signal });
    await fetched.promise;
    controller.abort();
    assert.equal((await work).shouldLabel, false);
    loaded.resolve(response());
    await tick();
    assert.equal(compilations, 0, 'canceled job compiled its late WASM response');
    assert.equal(requestSignal?.aborted, true, 'packaged load did not receive cancellation');
  } finally {
    loaded.resolve(response());
    instance.dispose();
    WebAssembly.compileStreaming = compile;
  }
});

test('canceling while reading original bytes prevents subsequent cryptographic processing', async () => {
  globalThis.fetch = async () => response();
  const reading = deferred<void>();
  const bytes = deferred<ArrayBuffer>();
  class DelayedBlob extends Blob {
    override arrayBuffer() { reading.resolve(); return bytes.promise; }
  }
  const fromBytes = WasmReader.fromBytes;
  let cryptoReads = 0;
  WasmReader.fromBytes = async (...args) => { cryptoReads += 1; return fromBytes(...args); };
  const instance = verifier();
  const controller = new AbortController();
  try {
    const work = instance.verify(new DelayedBlob([original], { type: 'image/jpeg' }), { representation: 'ORIGINAL_FILE', signal: controller.signal });
    await reading.promise;
    controller.abort();
    assert.equal((await work).shouldLabel, false);
    bytes.resolve(Uint8Array.from(original).buffer);
    await tick();
    assert.equal(cryptoReads, 0, 'canceled bytes entered the verifier after a late read');
  } finally {
    bytes.resolve(Uint8Array.from(original).buffer);
    instance.dispose();
    WasmReader.fromBytes = fromBytes;
  }
});

test('trust expiring during a genuine verification cannot return a positive', async () => {
  globalThis.fetch = async () => response();
  const now = Date.now;
  class ExpiringBlob extends Blob {
    override async arrayBuffer() {
      const bytes = await super.arrayBuffer();
      Date.now = () => Date.parse(PROVENANCE_TRUST_EXPIRES_AT) + 1;
      return bytes;
    }
  }
  const instance = verifier();
  try {
    const result = await instance.verify(new ExpiringBlob([original], { type: 'image/jpeg' }), { representation: 'ORIGINAL_FILE' });
    assert.equal(result.shouldLabel, false);
    assert.ok(result.reasonCodes.includes('C2PA_TRUST_SNAPSHOT_EXPIRED'));
  } finally {
    Date.now = now;
    instance.dispose();
  }
});
