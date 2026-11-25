/** Shared by production and the real-WASM smoke test. All arguments are pinned local PEM data. */
export function offlineSettingsJson(anchors: string, legacyRoot: string, timestampAnchors: string): string {
  const normalized = [anchors, legacyRoot, timestampAnchors].map((pem) => {
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g);
    if (!certificates?.length || pem.includes('PRIVATE KEY')) {
      throw new Error('Only packaged public trust certificates are accepted');
    }
    // Official trust-list PEM files include human-readable Subject lines. Keep only
    // certificate blocks so no URL-like annotation can be interpreted as a resource.
    return certificates.join('\n') + '\n';
  });
  return JSON.stringify({
    verify: {
      verify_trust: true,
      verify_after_reading: true,
      verify_timestamp_trust: true,
      ocsp_fetch: false,
      remote_manifest_fetch: false,
      skip_ingredient_conflict_resolution: false,
    },
    trust: { trust_anchors: normalized[0] + '\n' + normalized[1] },
    tsa_trust: { trust_anchors: normalized[2] + '\n' + normalized[1] },
  });
}
