export type ProvenanceStatus =
  | 'verified-generated'
  | 'verified-other'
  | 'untrusted'
  | 'invalid'
  | 'missing'
  | 'unsupported'
  | 'unavailable';

export interface ProvenanceResult {
  readonly status: ProvenanceStatus;
  readonly shouldLabel: boolean;
  readonly policyVersion: string;
  readonly detectorVersion: string;
  readonly reasonCodes: readonly string[];
}

export function provenanceResult(status: ProvenanceStatus, policyVersion: string, reason: string): ProvenanceResult {
  return {
    status,
    shouldLabel: status === 'verified-generated',
    policyVersion,
    detectorVersion: 'c2pa-wasm-0.15.2',
    reasonCodes: [reason],
  };
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue : undefined;
}

function codes(value: unknown): Set<string> {
  return new Set(Array.isArray(value)
    ? value.flatMap((item: unknown) => {
        const code = record(item)?.code;
        return typeof code === 'string' ? [code] : [];
      })
    : []);
}

const GENERATED = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
const ASSET_BINDINGS = new Set(['assertion.dataHash.match', 'assertion.bmffHash.match', 'assertion.boxesHash.match']);

/** Internal policy over a report returned by the real SDK, never supplied by a web page. */
export function evaluateManifest(value: unknown, policyVersion: string): ProvenanceResult {
  const result = (status: ProvenanceStatus, reason: string) => provenanceResult(status, policyVersion, reason);
  const store = record(value);
  const label = store?.active_manifest;
  const manifests = record(store?.manifests);
  if (typeof label !== 'string' || !manifests || !Object.hasOwn(manifests, label)) {
    return result('missing', 'C2PA_NO_ACTIVE_MANIFEST');
  }
  const manifest = record(manifests[label]);
  const checks = record(record(store?.validation_results)?.activeManifest);
  const success = codes(checks?.success);
  const failure = codes(checks?.failure);
  if (!success.has('signingCredential.trusted') &&
      (failure.size === 0 || [...failure].every((code) => code === 'signingCredential.untrusted'))) {
    return result('untrusted', 'C2PA_CREDENTIAL_UNTRUSTED');
  }
  if (store?.validation_state !== 'Trusted' || failure.size > 0 ||
      !success.has('claimSignature.validated') ||
      ![...ASSET_BINDINGS].some((code) => success.has(code)) ||
      [...codes(checks?.informational)].some((code) => /untrusted|revoked|mismatch|expired/i.test(code))) {
    return result('invalid', 'C2PA_VALIDATION_FAILED');
  }
  if (!manifest || !Array.isArray(manifest.assertions)) {
    return result('verified-other', 'C2PA_NO_GENERATION_ASSERTION');
  }

  const creationActions: RecordValue[] = [];
  for (const assertion of manifest.assertions) {
    const item = record(assertion);
    if (typeof item?.label !== 'string' || !/^c2pa\.actions(?:\.v[123])?$/.test(item.label)) continue;
    const actions = record(item.data)?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      const candidate = record(action);
      if (candidate?.action === 'c2pa.created') creationActions.push(candidate);
    }
  }
  if (creationActions.length === 0 || creationActions.some((action) => action.digitalSourceType !== GENERATED)) {
    return result('verified-other', 'C2PA_NO_UNAMBIGUOUS_GENERATION');
  }
  // A region/ingredient assertion establishes only that region or ingredient's origin.
  // It cannot authorize an asset-level badge, including on a complete video.
  if (creationActions.some((action) =>
      action.regionOfInterest !== undefined || action.regions !== undefined ||
      record(action.parameters)?.ingredients !== undefined ||
      record(action.parameters)?.ingredient !== undefined)) {
    return result('verified-other', 'C2PA_GENERATION_SCOPE_AMBIGUOUS');
  }
  return result('verified-generated', 'C2PA_TRUSTED_ASSET_GENERATION');
}
