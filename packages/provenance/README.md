# Local C2PA verification

`@label-ai/provenance` verifies original media bytes with the official
`@contentauth/c2pa-wasm` 0.15.2 engine. The same packaged Rust/WASM verifier runs in
the extension's background context on Chromium and Safari. It uses the SDK's
`WasmReader.fromBytes` API, so it does not require a nested worker, a blob worker,
`FileReaderSync`, or a remote service.

## API and ownership

```ts
import { createProvenanceVerifier } from '@label-ai/provenance';

const verifier = createProvenanceVerifier({
  wasmUrl: browser.runtime.getURL('/c2pa/c2pa_bg.wasm'),
});
const result = await verifier.verify(originalBlob, {
  representation: 'ORIGINAL_FILE',
  signal: abortController.signal,
});
verifier.dispose();
```

The caller must establish that the original bytes belong to the currently
displayed media. A URL string or a hash embedded in a site's URL alone does not
establish that binding. Rendered canvas frames and re-encoded image bytes are
ineligible for provenance verification. The extension must also invalidate
results when its media source, generation, consent, policy, or trust snapshot
changes. This package never fetches media and never accepts validation reports
from page scripts.

Only `status: 'verified-generated'` returns `shouldLabel: true`. Other statuses
are `verified-other`, `untrusted`, `invalid`, `missing`, `unsupported`, and
`unavailable`. None of those outcomes proves that media is human-created.

## Positive decision policy

A positive requires all of the following in the report returned by the real SDK:

- A current active manifest with trusted signing credentials, a valid signature,
  and a validated binding to the complete original asset's bytes.
- Trusted overall validation state and no active validation failure or
  contradictory untrusted, revoked, expired, or mismatched status.
- An explicit `c2pa.created` action in the active manifest's recognized actions
  assertion with the IPTC `trainedAlgorithmicMedia` source type.
- No conflicting creation source, region or temporal restriction, or ambiguous
  ingredient scope.

Generation mentioned only in an ingredient, an editing action, or a partial
video interval cannot authorize a whole-asset label. Ordinary capture, digital
art, composites, fabricated text, malformed reports, and missing credentials
also cannot authorize one. Trusted provenance validates a signed claim; it is
not an independent forensic guarantee about the truthfulness of its issuer.

## Offline trust and privacy

The reviewed production trust snapshot is recorded with URLs and SHA-256 hashes
in `assets/trust-manifest.json`. It combines C2PA conformance roots, timestamp
roots, and one published production Adobe legacy root. No test signer is trusted
by the shipped code. Trust configuration is internal, not a page-controlled or
public API option.

The snapshot expires on **2027-02-22 at 00:00 UTC**. After expiry, verification
abstains until a reviewed extension update ships a refreshed snapshot. Consumers
must cap any displayed result's expiry at this trust deadline. The SDK validates
timestamps against the pinned timestamp roots. Remote manifests and online OCSP
fetches are disabled. This means the verifier cannot discover revocations that
occur after its offline snapshot; that limitation must remain in release notes.

The only fetch made by this package loads its same-extension packaged WASM. It
uses the upstream SHA-512 integrity value, omits credentials, and rejects
redirects. Raw media, media hashes, credentials, embedded URLs, extracted
metadata, and decisions are never transmitted by this package. Raw SDK exception
text is not returned because malformed metadata could contain private text.

## Resource limits and cancellation

The package admits JPEG, PNG, WebP, AVIF, MP4, and WebM original bytes. The SDK may
still reject a particular format, encoding, or malformed asset. Package limits
are 15 MiB per image, 100 MiB per video, eight queued requests, and 128 MiB total
queued input. The extension's intake imposes a tighter 4 MiB original-file bound;
package-level support does not imply that larger files can reach it through the
shipping extension.

Verification is serialized, readers are freed after use, and disposed/canceled
or overdue results cannot authorize a label. The default deadline is 15 seconds.
Synchronous WASM parsing cannot be interrupted by a JavaScript timer while it
occupies the context, so an elapsed-time check also rejects late results. The
deadline is a decision bound, not a guarantee of immediate CPU interruption.
Disposal releases references and stops new work; JavaScript garbage collection
and the WASM heap are reclaimed by the runtime, not securely zeroized.

## Verification

From the repository root:

```sh
python tools/prepare_provenance_fixtures.py
pnpm --filter @label-ai/provenance test
pnpm --filter @label-ai/provenance typecheck
```

The integration tests compile the actual packaged WASM, verify its upstream
integrity, and reject every attempted network fetch. They check these pinned,
MIT-licensed upstream fixtures:

| Fixture | Actual expected decision | Coverage |
| --- | --- | --- |
| Adobe Firefly JPEG | `verified-generated` | Trusted production signer and active generation claim |
| Altered Firefly JPEG | `invalid` | Main-image byte binding fails |
| Camera/editing JPEG | `verified-other` | Trusted provenance without whole-asset generation |
| ChatGPT PNG | `invalid` | Expired signing credential is not overridden |
| Sora MP4 | `invalid` | Generated video assertion with expired/untrusted credentials |
| Unsigned PNG | `missing` | No provenance is not a positive |

An unrelated production root and fabricated generation text are additional
negative controls. Policy tests cover malformed status arrays, partial temporal
and image regions, ingredients, conflicting creation claims, and absent binding
or signature checks. Repeated real verification checks deterministic results and
reader cleanup. These tests do not claim a positive signed-video fixture.

`tests/browser/` provides a Vite/Playwright harness for the same public API.
Native browser and Safari integration must also pass on their supported hosts;
successful WASM tests alone do not establish extension installation or native
Safari compatibility. This workspace's Chromium launch was blocked by the
environment's Unix-socket restriction before any browser assertion ran.

## Upstream attribution

- [Content Authenticity Initiative c2pa-js](https://github.com/contentauth/c2pa-js),
  including `@contentauth/c2pa-wasm`: MIT, copyright 2025 Adobe. The extension build
  includes the dependency's complete license as `licenses/C2PA-WASM-MIT.txt`.
- [C2PA conformance public trust lists](https://github.com/c2pa-org/conformance-public):
  CC BY 4.0. The complete license is in
  `assets/C2PA-TRUST-LIST-LICENSE.txt` and is copied into the extension package.
  Snapshot attribution and the one legacy-root selection are recorded in the
  trust manifest; the distributed PEM lists retain their source contents.
- [CAI example assets](https://github.com/contentauth/example-assets): MIT.
  `tests/fixtures/provenance/LICENSE.txt` accompanies the pinned source manifest.
  Large test fixtures are downloaded and digest-checked; they are not shipped
  with the extension.
- [C2PA specification, actions and changes](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html):
  the policy treats a creation action restricted to a changed region or time
  interval as insufficient evidence for an entire image or video.
