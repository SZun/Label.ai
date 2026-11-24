import assert from 'node:assert/strict';
import test from 'node:test';
import { packagedAssetUrl, validateModelBytes } from '../src/assets.ts';

test('PRIV-ASSET-01 detector can only fetch resources shipped with the extension', () => {
  assert.equal(packagedAssetUrl('chrome-extension://example/models/', 'detectra-v3.onnx'), 'chrome-extension://example/models/detectra-v3.onnx');
  assert.equal(packagedAssetUrl('safari-web-extension://example/models/', 'detectra-v3.onnx'), 'safari-web-extension://example/models/detectra-v3.onnx');
  for (const base of ['https://example.com/models/', 'http://localhost/', 'data:text/plain,a', 'file:///tmp/', 'chrome-extension://example/models/?url=private']) {
    assert.throws(() => packagedAssetUrl(base, 'detectra-v3.onnx'), /packaged|extension|asset/i);
  }
  for (const name of ['../secret', 'https://example.com/model', '//example.com/model', 'a?b', 'a#b']) {
    assert.throws(() => packagedAssetUrl('chrome-extension://example/models/', name), /asset/i);
  }
});

test('DET-ASSET-02 rejects missing/truncated/untrusted model weights', async () => {
  await assert.rejects(validateModelBytes(new Uint8Array(10)), /size|length|checksum/i);
});
