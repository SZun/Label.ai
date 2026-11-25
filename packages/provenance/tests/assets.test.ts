import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('packaged production trust roots match the reviewed snapshot and contain no test keys', () => {
  const base = new URL('../assets/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('trust-manifest.json', base), 'utf8'));
  for (const entry of manifest.sources) {
    const bytes = readFileSync(new URL(entry.file, base));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    const pem = bytes.toString('utf8');
    assert.ok(!pem.includes('PRIVATE KEY'));
    const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    assert.ok(certificates.length > 0);
    for (const data of certificates) {
      const certificate = new X509Certificate(data);
      assert.ok(certificate.ca);
      assert.doesNotMatch(certificate.subject, /test|example|localhost/i);
    }
  }
});

test('known-origin fixture bytes match their pinned licenses/source manifest', () => {
  const base = new URL('../../../tests/fixtures/provenance/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  for (const entry of manifest.assets) {
    const bytes = readFileSync(new URL(entry.file, base));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
});
