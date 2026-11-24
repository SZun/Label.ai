import anchors from '../assets/c2pa-anchors.pem?raw';
import legacyAdobeRoot from '../assets/adobe-legacy-root.pem?raw';
import timestampAnchors from '../assets/timestamp-anchors.pem?raw';
import type { Settings } from '@contentauth/c2pa-web';

export const PROVENANCE_POLICY_VERSION = 'c2pa-trust-2026-11-24.1';
export const PROVENANCE_TRUST_EXPIRES_AT = '2027-02-22T00:00:00Z';

/** Pinned production roots only. Certificates and revocation data are never fetched while browsing. */
export function offlineTrustSettings(): Settings {
  return {
    verify: {
      verifyTrust: true,
      verifyAfterReading: true,
      verifyTimestampTrust: true,
      ocspFetch: false,
      remoteManifestFetch: false,
      skipIngredientConflictResolution: false,
    },
    trust: { trustAnchors: anchors + '\n' + legacyAdobeRoot, verifyTrustList: true },
    tsaTrust: { trustAnchors: timestampAnchors + '\n' + legacyAdobeRoot, verifyTrustList: true },
  };
}
