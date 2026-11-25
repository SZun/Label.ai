import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePackagedAssetUrl } from '../src/guards.ts';

for (const scheme of ['chrome-extension:', 'safari-web-extension:', 'moz-extension:']) {
  test(`allows only the current ${scheme} package for WASM`, () => {
    assert.equal(validatePackagedAssetUrl('/c2pa/c2pa_bg.wasm', `${scheme}//this-package/runtime.html`), `${scheme}//this-package/c2pa/c2pa_bg.wasm`);
    assert.throws(() => validatePackagedAssetUrl(`${scheme}//other-package/c2pa_bg.wasm`, `${scheme}//this-package/runtime.html`));
    assert.throws(() => validatePackagedAssetUrl('https://cdn.example.com/c2pa.wasm', `${scheme}//this-package/runtime.html`));
  });
}

test('supports same-origin local browser test harness without allowing remote assets', () => {
  assert.equal(validatePackagedAssetUrl('/c2pa.wasm', 'http://127.0.0.1:4173/'), 'http://127.0.0.1:4173/c2pa.wasm');
  assert.throws(() => validatePackagedAssetUrl('http://127.0.0.1:4174/c2pa.wasm', 'http://127.0.0.1:4173/'));
});

test('rejects data/blob/http remote code and credentials/query/fragment injection', () => {
  for (const candidate of [
    'data:application/wasm;base64,AAAA', 'blob:https://example.com/uuid',
    'https://user:password@example.com/c2pa.wasm', '/c2pa.wasm?source=private', '/c2pa.wasm#private',
  ]) assert.throws(() => validatePackagedAssetUrl(candidate, 'https://example.com/runtime.html'));
});
