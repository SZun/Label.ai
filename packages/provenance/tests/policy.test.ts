import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateManifest } from '../src/policy.ts';

const SOURCE = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
const POLICY = 'unit-test-policy';
const active = 'urn:c2pa:active';

function trustedStore(source = 'trainedAlgorithmicMedia') {
  return {
    active_manifest: active,
    manifests: {
      [active]: {
        assertions: [{
          label: 'c2pa.actions.v2',
          data: { actions: [{ action: 'c2pa.created', digitalSourceType: SOURCE + source }] },
        }],
      },
    },
    validation_state: 'Trusted',
    validation_results: {
      activeManifest: {
        success: [
          { code: 'signingCredential.trusted' },
          { code: 'claimSignature.validated' },
          { code: 'assertion.dataHash.match' },
        ],
        failure: [],
        informational: [],
      },
    },
  };
}

test('trusted signature, active asset binding, and explicit whole-asset generation authorize label', () => {
  const result = evaluateManifest(trustedStore(), POLICY);
  assert.equal(result.status, 'verified-generated');
  assert.equal(result.shouldLabel, true);
  assert.equal(result.policyVersion, POLICY);
});

for (const source of ['digitalCapture', 'digitalArt', 'composite', 'compositeWithTrainedAlgorithmicMedia']) {
  test(`a trusted ${source} assertion is not whole-asset AI generation`, () => {
    const result = evaluateManifest(trustedStore(source), POLICY);
    assert.equal(result.shouldLabel, false);
    assert.equal(result.status, 'verified-other');
  });
}

test('unsigned or untrusted manifests cannot authorize a positive', () => {
  const store = trustedStore();
  store.validation_state = 'Valid';
  store.validation_results.activeManifest.success = store.validation_results.activeManifest.success
    .filter(({ code }) => code !== 'signingCredential.trusted');
  assert.equal(evaluateManifest(store, POLICY).status, 'untrusted');
  assert.equal(evaluateManifest(store, POLICY).shouldLabel, false);
});

for (const code of ['claimSignature.validated', 'assertion.dataHash.match']) {
  test(`generation assertion without ${code} proof cannot label`, () => {
    const store = trustedStore();
    store.validation_results.activeManifest.success = store.validation_results.activeManifest.success
      .filter((status) => status.code !== code);
    assert.equal(evaluateManifest(store, POLICY).status, 'invalid');
    assert.equal(evaluateManifest(store, POLICY).shouldLabel, false);
  });
}

test('tampered asset and manifest validation failures override generation assertions', () => {
  const store = trustedStore();
  store.validation_results.activeManifest.failure = [{ code: 'assertion.dataHash.mismatch' }];
  assert.equal(evaluateManifest(store, POLICY).status, 'invalid');
});

test('AI generation inside a parent ingredient does not classify the active captured asset', () => {
  const store = trustedStore('digitalCapture');
  store.manifests['urn:c2pa:parent'] = trustedStore().manifests[active];
  assert.equal(evaluateManifest(store, POLICY).shouldLabel, false);
});

test('AI edit alone and partial-region creation abstain', () => {
  const edited = trustedStore();
  edited.manifests[active].assertions[0].data.actions[0].action = 'c2pa.edited';
  assert.equal(evaluateManifest(edited, POLICY).shouldLabel, false);
  const partial = trustedStore();
  Object.assign(partial.manifests[active].assertions[0].data.actions[0], {
    regionOfInterest: { type: 'temporal', start: 0, end: 1 },
  });
  assert.equal(evaluateManifest(partial, POLICY).shouldLabel, false);
});

test('conflicting active created assertions abstain', () => {
  const store = trustedStore();
  store.manifests[active].assertions[0].data.actions.push({
    action: 'c2pa.created', digitalSourceType: SOURCE + 'digitalCapture',
  });
  assert.equal(evaluateManifest(store, POLICY).shouldLabel, false);
});

test('missing and malformed reports cannot produce a positive', () => {
  for (const input of [null, undefined, {}, [], 'trainedAlgorithmicMedia', { active_manifest: '__proto__', manifests: {} }]) {
    assert.equal(evaluateManifest(input, POLICY).shouldLabel, false);
  }
});

test('video binding accepts validated BMFF hashes, never a frame/ingredient result', () => {
  const store = trustedStore();
  store.validation_results.activeManifest.success[2] = { code: 'assertion.bmffHash.match' };
  assert.equal(evaluateManifest(store, POLICY).shouldLabel, true);
});

for (const field of ['changes', 'changed']) {
  test(`a ${field} region or temporal restriction cannot authorize a whole-asset label`, () => {
    const store = trustedStore();
    Object.assign(store.manifests[active].assertions[0].data.actions[0], {
      [field]: [{ type: 'temporal', start: 0, end: 1 }],
    });
    const result = evaluateManifest(store, POLICY);
    assert.equal(result.shouldLabel, false);
    assert.equal(result.status, 'verified-other');
  });
}

test('malformed validation status collections cannot be silently treated as successful validation', () => {
  for (const field of ['success', 'failure', 'informational']) {
    for (const malformed of ['unexpected', [{ unknown: 'error' }], [{ code: 42 }]]) {
      const store = trustedStore();
      Object.assign(store.validation_results.activeManifest, { [field]: malformed });
      const result = evaluateManifest(store, POLICY);
      assert.equal(result.shouldLabel, false, `${field} accepted malformed statuses`);
      assert.equal(result.status, 'invalid');
    }
  }
});
