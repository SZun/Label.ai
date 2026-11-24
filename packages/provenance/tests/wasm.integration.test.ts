import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test, { after, before } from 'node:test';
import { WASM_SRI } from '@contentauth/c2pa-wasm';
import { initializeWasm, verifyBytes } from '../src/wasm.ts';
import { offlineSettingsJson } from '../src/settings.ts';

const require = createRequire(import.meta.url);
const asset = (name: string) => readFileSync(new URL(`../assets/${name}`, import.meta.url), 'utf8');
const fixture = (name: string) => readFileSync(new URL(`../../../tests/fixtures/provenance/${name}`, import.meta.url));
const settings = offlineSettingsJson(asset('c2pa-anchors.pem'), asset('adobe-legacy-root.pem'), asset('timestamp-anchors.pem'));
const originalFetch = globalThis.fetch;
let fetchAttempts = 0;

before(async () => {
  globalThis.fetch = async () => {
    fetchAttempts += 1;
    throw new Error('Network access forbidden in local provenance verification');
  };
  const bytes = readFileSync(require.resolve('@contentauth/c2pa-wasm/c2pa.wasm'));
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, WASM_SRI);
  await initializeWasm(await WebAssembly.compile(bytes));
});

after(() => {
  globalThis.fetch = originalFetch;
  assert.equal(fetchAttempts, 0, 'C2PA verification attempted a network request');
});

for (const [file, mime, expected] of [
  ['firefly-generated.jpg', 'image/jpeg', 'verified-generated'],
  ['firefly-tampered.jpg', 'image/jpeg', 'invalid'],
  ['camera-edited.jpg', 'image/jpeg', 'verified-other'],
  ['chatgpt-expired.png', 'image/png', 'invalid'],
  ['unsigned.png', 'image/png', 'missing'],
] as const) {
  test(`real packaged WASM validates ${file} as ${expected} without network`, async () => {
    const result = await verifyBytes(fixture(file), mime, settings, 'c2pa-trust-2026-11-24.1');
    assert.equal(result.status, expected);
    assert.equal(result.shouldLabel, expected === 'verified-generated');
    assert.equal(result.detectorVersion, 'c2pa-wasm-0.15.2');
  });
}

test('actual crypto validation refuses the generated fixture with an unrelated production trust anchor', async () => {
  const pem = asset('c2pa-anchors.pem').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  assert.ok(pem);
  const unrelated = offlineSettingsJson(pem, pem, asset('timestamp-anchors.pem'));
  const result = await verifyBytes(fixture('firefly-generated.jpg'), 'image/jpeg', unrelated, 'unrelated-trust-test');
  assert.equal(result.shouldLabel, false);
  assert.equal(result.status, 'untrusted');
});

test('malformed input and a fabricated text generation claim cannot pass genuine WASM verification', async () => {
  const bytes = new TextEncoder().encode('{"digitalSourceType":"trainedAlgorithmicMedia","trusted":true}');
  const result = await verifyBytes(bytes, 'image/jpeg', settings, 'c2pa-trust-2026-11-24.1');
  assert.equal(result.shouldLabel, false);
});

test('repeated actual verification releases reader handles and remains deterministic', async () => {
  const bytes = fixture('firefly-generated.jpg');
  const first = await verifyBytes(bytes, 'image/jpeg', settings, 'c2pa-trust-2026-11-24.1');
  for (let repeat = 0; repeat < 8; repeat += 1) {
    assert.deepEqual(await verifyBytes(bytes, 'image/jpeg', settings, 'c2pa-trust-2026-11-24.1'), first);
  }
});
